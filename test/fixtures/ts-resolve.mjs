/**
 * A module resolve hook that reads an import of `./x.js` as `./x.ts` when no `x.js` exists.
 * @param {string} specifier - What the import names.
 * @param {object} context - The importing module and the conditions.
 * @param {Function} next - The next hook.
 * @returns {Promise<object>} The resolved module.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.endsWith(".js")) throw error;
    return next(`${specifier.slice(0, -3)}.ts`, context);
  }
}
