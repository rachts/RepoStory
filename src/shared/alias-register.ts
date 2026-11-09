import Module from "node:module";
import path from "node:path";

const mod = Module as unknown as { _resolveFilename: (req: string, parent: unknown, isMain: boolean, options: unknown) => string };
const origResolve = mod._resolveFilename;

mod._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
  if (typeof request === "string" && request.startsWith("@/")) {
    request = path.resolve(__dirname, "..", request.slice(2));
  }
  return origResolve.call(this, request, parent, isMain, options);
};
