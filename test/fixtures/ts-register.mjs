// Lets `node --import <this file> src/bin.ts` run the sources as they are: the sources import `./x.js` and mean `./x.ts`.
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
