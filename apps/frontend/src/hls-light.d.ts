// hls.js ships no typings for its light build; it has the same API as the full one.
declare module 'hls.js/light' {
  export { default } from 'hls.js';
}
