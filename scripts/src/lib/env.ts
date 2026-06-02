import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up from scripts/src/lib/ to the repo root
const repoRoot = resolve(__dirname, '..', '..', '..');
const envPath = resolve(repoRoot, '.env');

config({ path: envPath });

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Expected it in ${envPath}`
    );
  }
  return v;
}

export const env = {
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
};

export const REPO_ROOT = repoRoot;
