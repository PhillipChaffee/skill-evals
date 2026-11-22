# Timeout of zero

A user reports that `loadConfig` in `src/config.js` returns a timeout of 0
when the settings file leaves out `timeout`, so every request fails at once.
It should fall back to 30. Fix it.
