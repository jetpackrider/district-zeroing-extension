// The real page loads mapbox-gl.js v2.11.0, whose UMD wrapper assigns window.mapboxgl.
// The fixture uses MapLibre (same API surface we touch) and assigns it the same way,
// so the extension's document_start constructor trap sees a normal global assignment.
// ?nomap=1 hides it under another name (simulates DRA renaming things).
if (!new URLSearchParams(location.search).get('nomap')) window.mapboxgl = window.maplibregl;
