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
  // deploy; a failure rolls the Worker back to its previous version.
  health: z.string().optional(),
});

export const ManifestSchema = z
  .strictObject({
    product: z.string().regex(NAME),
    // ideaSquared bot project that gets the deploy message in its -github channel (e.g. gaminginit).
    discord: z.string().regex(NAME).optional(),
    environments: z.record(z.string().regex(NAME), EnvironmentSchema),
    // Check runs that must have succeeded on the SHA before it deploys.
    checks: z.array(z.string().min(1)).default([]),
    // Deployed in the order written; a failure stops the rest.
    components: z.record(z.string().regex(NAME), CloudflareWorkerSchema),
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
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type Component = Manifest['components'][string];
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
