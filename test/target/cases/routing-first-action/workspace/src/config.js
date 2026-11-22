export function loadConfig(settings) {
  return { timeout: settings.timeout ?? 0, retries: settings.retries ?? 3 };
}
