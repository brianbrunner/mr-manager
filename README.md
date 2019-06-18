# Mr. Manager

Generic process monitor/manager for development environments. You can run multiple commands in the same shell, track
their state from building to ready (or failure if you made a mistake). Has some nice bonuses like autoreload and
more in the works.

# Running

Any of the following aliases will work to get `mr-manager` up and running:

```
mr-manager
mr-man
mrm
```

## Command Line Options

You may supply one or more positional arguments to run a subset of the commands defined in your config file e.g.

```
mrm frontend *-svc backend-*
```

The following named arguments are supported:

* `-c` - config file location, if not specified looks for `mrm.toml` or `mrm.yaml` in the `cwd`

# Config File Format

Config files can be specified in either [yaml](https://yaml.org/) or [toml](https://github.com/toml-lang/toml). For
the sake of conciseness and familiarity, we'll go with yaml for the example.

```yaml
version: "exp"

commands:

  - name: "backend"
    command: "node"
    args:
      - "index.js"
    watch:
      - "./backend/*.js"
    options:
      cwd: "./backend"
    ready:
      - "Listening on"

    install:

      - name: 'deps'
        command: 'yarn'
        args:
          - "install"
        options:
          cwd: "./backend"

  - name: "frontend"
    command: "yarn"
    args:
      - "webpack"
    building:
      - "Compiling"
    ready:
      - "Compiled"
      - "Built at"
    failed:
      - "Failed to compile"
    options:
      cwd: "./frontend"

    install:

      - name: 'deps'
        command: 'yarn'
        args:
          - "install"
        options:
          cwd: "./frontend"
```

There are two top level params:

* `version` - for the time being, always `"exp"` to indicate that this is still an in-flux config file format
* `commands` - a list of commands that `mr-manager` should run

Each command has the following format:

* `name` - a human-readable name for the command
* `command` - the command to run
* `args` - a list of arguments to pass to the command
* `options` - a map of options for running the command, passed directly to node's [child_process.spawn method](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options)
* `watch` - can be a string, an array or a map with the keys `paths` and `options`. used as arguments to [chokidar](https://github.com/paulmillr/chokidar) for autoreloading a command. this is only needed if your command doesn't have some built-in way of auto-reloading
* `building` - a list of regexes to match against to determine when your process is building
* `ready` - a list of regexes to match against to determine when your process has built successfully and is ready
* `failed` - a list of regexes to match against to determine when your process has failed to build
* `install` - a list of commands to run prior to running the parent command, only occurs on the initial run and does not retrigger on subsequent refreshes, usually handles installing dependencies or any other setup, these have the same format and parameters as a top level command

# Gotchas

By default, the `watch` option will ignore `node_modules` directories since including them can cause heavy CPU usage
when starting the watcher. There currently isn't a way to disable this outside of altering the code yourself.

`ready`/`building`/`failed` are always interpreted as regexes. Make sure to include escape characters in them if you
need to.
