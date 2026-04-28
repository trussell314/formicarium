/// <reference types="vite/client" />

declare module '*?worker' {
  const Worker: { new (options?: WorkerOptions): Worker };
  export default Worker;
}
