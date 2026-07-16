declare module "http" {
  const x: any;
  export default x;
}

declare module "url" {
  export const URL: any;
}

// Minimal shims so TypeScript doesn't fail on this wrapper in a bundler-less setup.
declare const process: any;

declare const Buffer: { concat: (chunks: any[]) => any; from: (v: any) => any };


