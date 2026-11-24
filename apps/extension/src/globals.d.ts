declare const __ZD_TEST__: boolean;
/** 'store' (npm run build), 'test' (build:test) or 'local' (build:local, data embedded). */
declare const __ZD_BUILD__: 'store' | 'test' | 'local';
/** States whose bundles are embedded in this build (local build only). */
declare const __ZD_EMBEDDED_STATES__: string[];
declare const __ZD_HOST_PATTERNS__: string[];
/** Default data base URL; `extension:<path>` means the extension's own files. */
declare const __ZD_DATA_URL__: string;

declare module 'maplibre-gl/dist/maplibre-gl-csp.js' {
  import maplibregl from 'maplibre-gl';
  export default maplibregl;
}
