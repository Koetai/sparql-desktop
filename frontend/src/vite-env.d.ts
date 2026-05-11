/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ORCID_CLIENT_ID: string;
  readonly VITE_ORCID_BASE_URL: string;
  readonly VITE_WORKER_URL: string;
  readonly VITE_GITHUB_REPO: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
