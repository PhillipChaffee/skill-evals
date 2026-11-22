# Two broken exports

Two things are wrong in the nightly export. `loadConfig` returns a timeout of 0
when the settings file leaves out `timeout`, and the CSV writer drops the last
row when the file does not end in a newline. Work out which hurts more users,
then fix that one.
