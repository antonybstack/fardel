/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FARDEL_URI?: string;
  readonly VITE_FARDEL_DB?: string;
  readonly VITE_FARDEL_QA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

