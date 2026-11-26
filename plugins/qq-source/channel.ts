// `up` starts sources that keep a connection open as channels; the work itself is in source.ts. Keeping this entry thin
// means one implementation, whichever name the loader asks for.
export { default } from "./source.ts";
