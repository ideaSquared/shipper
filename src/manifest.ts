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
  // it leaves out has no health check.
  health: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
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
    // ideaSquared bot project that gets the deploy message in its -github channel (e.g. gaminginit).
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
    Object.entries(manifest.components).forEach(([name, component]) =>
      Object.keys(component.type === 'cloudflare-worker' && typeof component.health === 'object' ? component.health : {})
        .filter((env) => !(env in manifest.environments))
        .forEach((env) =>
          ctx.addIssue({ code: 'custom', path: ['components', name, 'health', env], message: `unknown environment '${env}'` }),
        ),
    );
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type Component = Manifest['components'][string];
export type CloudflareWorker = Extract<Component, { type: 'cloudflare-worker' }>;
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
export function healthFor(component: CloudflareWorker, environment: string): string | undefined {
  if (typeof component.health === 'object') return component.health[environment];
  return component.health;
}
