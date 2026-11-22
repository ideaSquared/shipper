import { parse } from 'yaml';
import { z } from 'zod';

const NAME = /^[a-z][a-z0-9-]*$/;

const EnvironmentSchema = z.strictObject({
  // Environments this one only accepts SHAs from: the SHA must already be
  // deployed successfully to each of them.
  requires: z.array(z.string()).default([]),
  // Name passed to `wrangler --env`. Omit to use the top level of wrangler config.
  wranglerEnv: z.string().optional(),
});

const D1MigrationsSchema = z.strictObject({ d1: z.string().min(1) });

// A health check: a path or URL, or { url, expect } to also require the response body to contain `expect`.
const HealthCheckSchema = z.union([
  z.string(),
  z.strictObject({
    url: z.string().min(1),
    // Plain substring the response body must contain, e.g. '"status":"ok"'. Catches a 200 from the wrong app.
    expect: z.string().min(1).optional(),
  }),
]);

// Parsed, not just prefix-matched: smoke runs after the release is live, so a typo must fail here instead.
const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && !/\s/.test(value);
  } catch {
    return false;
  }
};
const HttpsUrlSchema = z.string().refine(isHttpsUrl, 'must be a full https URL');

// A smoke check: a full https URL, or { url, expect } with the same substring semantics as a health check.
const SmokeCheckSchema = z.union([
  HttpsUrlSchema,
  z.strictObject({
    url: HttpsUrlSchema,
    // Plain substring the response body must contain. Never logged.
    expect: z.string().min(1).optional(),
  }),
]);

const CloudflareWorkerSchema = z.strictObject({
  type: z.literal('cloudflare-worker'),
  // Directory holding the component's wrangler config, relative to the repo root.
  path: z.string().default('.'),
  // Shell command run from the repo root before deploying.
  build: z.string().optional(),
  migrations: D1MigrationsSchema.optional(),
  // Path on the deployed URL (e.g. /health) or a full https URL. Polled after
  // deploy; a failure rolls the Worker back to its previous version. A record
  // ({ staging: ..., production: ... }) sets it per environment; an environment
  // it leaves out has no health check. Each check is a string or { url, expect }; `expect` is only
  // available inside the per-environment record.
  health: z.union([z.string(), z.record(z.string(), HealthCheckSchema)]).optional(),
});

// Deployed by the repo's own workflow, which calls shipper's gate.yml before it and report.yml
// after it. Listed so ship.yaml says how the product deploys; shipper's deploy job refuses it.
const ExternalSchema = z.strictObject({
  type: z.literal('external'),
  // Where the deploy happens, e.g. ".github/workflows/deploy.yml".
  workflow: z.string().min(1),
});

const ComponentSchema = z.discriminatedUnion('type', [CloudflareWorkerSchema, ExternalSchema]);

export const ManifestSchema = z
  .strictObject({
    product: z.string().regex(NAME),
    // ideaSquared bot project that gets the deploy message in its -github channel (e.g. creatrgrid).
    discord: z.string().regex(NAME).optional(),
    environments: z.record(z.string().regex(NAME), EnvironmentSchema),
    // Check runs that must have succeeded on the SHA before it deploys.
    checks: z.array(z.string().min(1)).default([]),
    // How `ship deploy` starts a deploy: a workflow with a workflow_dispatch trigger that calls shipper.
    dispatch: z
      .strictObject({
        workflow: z.string().min(1),
        // Name of the workflow's input that takes the environment. Omit if the workflow has a single target.
        environmentInput: z.string().min(1).optional(),
        // The workflow `ship rollback` starts (file in .github/workflows). Default: ship-rollback.yml.
        rollbackWorkflow: z.string().min(1).optional(),
      })
      .optional(),
    // Repo-relative directories holding migration files (`*` matches one path segment, e.g.
    // services/*/src/migrations). `ship diff` and the deploy preview list the files a deploy adds there.
    // Not the component-level `migrations: { d1 }`, which names the D1 binding to apply.
    migrations: z.array(z.string().min(1)).optional(),
    // Post-deploy smoke checks per environment, requested once after every component deployed and passed its
    // health check. A failure fails the deploy but does not roll back.
    smoke: z.record(z.string(), z.array(SmokeCheckSchema)).optional(),
    // Deployed in the order written; a failure stops the rest.
    components: z.record(z.string().regex(NAME), ComponentSchema),
  })
  .superRefine((manifest, ctx) => {
    if (Object.keys(manifest.environments).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['environments'], message: 'define at least one environment' });
    }
    if (Object.keys(manifest.components).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: 'define at least one component' });
    }
    Object.entries(manifest.environments).forEach(([name, env]) =>
      env.requires
        .filter((required) => required === name || !(required in manifest.environments))
        .forEach((required) =>
          ctx.addIssue({
            code: 'custom',
            path: ['environments', name, 'requires'],
            message: required === name ? `'${name}' cannot require itself` : `unknown environment '${required}'`,
          }),
        ),
    );
    Object.keys(manifest.smoke ?? {})
      .filter((env) => !(env in manifest.environments))
      .forEach((env) => ctx.addIssue({ code: 'custom', path: ['smoke', env], message: `unknown environment '${env}'` }));
    Object.entries(manifest.components).forEach(([name, component]) =>
      Object.keys(component.type === 'cloudflare-worker' && typeof component.health === 'object' ? component.health : {})
        .filter((env) => !(env in manifest.environments))
        .forEach((env) => ctx.addIssue({ code: 'custom', path: ['components', name, 'health', env], message: `unknown environment '${env}'` })),
    );
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type Component = Manifest['components'][string];
export type CloudflareWorker = Extract<Component, { type: 'cloudflare-worker' }>;
export type HealthCheck = { url: string; expect?: string | undefined };
export type Environment = Manifest['environments'][string];

export function parseManifest(text: string): Manifest {
  const result = ManifestSchema.safeParse(parse(text));
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new Error(`ship.yaml is invalid:\n${issues.join('\n')}`);
}

export function environmentOf(manifest: Manifest, name: string): Environment {
  const env = manifest.environments[name];
  if (env) return env;
  const known = Object.keys(manifest.environments).join(', ');
  throw new Error(`environment '${name}' is not in ship.yaml (known: ${known})`);
}

// The component's health check for one environment, if it has one there.
export function healthFor(component: CloudflareWorker, environment: string): HealthCheck | undefined {
  const health = typeof component.health === 'object' ? component.health[environment] : component.health;
  if (typeof health === 'string') return health === '' ? undefined : { url: health };
  return health;
}
