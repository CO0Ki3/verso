// Enables verso's own blocks in this package's program. Nothing may import this file: a program that compiles the
// package's source without it, such as a consumer's, must not have the key. It declares no import or export, so the
// interface below is global and merges with the one the helpers declare.
interface VersoEnabled {
  verso: true;
}
