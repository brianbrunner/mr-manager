#!/usr/bin/env node

const {spawn} = require('child_process');
const fs = require('fs');
const {argv} = require('yargs');
const toml = require('toml');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const kill = require('tree-kill');
const chokidar = require('chokidar');
const minimatch = require('minimatch');

const CHARS = {
  RED: '\u001b[31;1m',
  BG_RED: '\u001b[30m\u001b[41m',
  MAGENTA: '\u001b[35;1m',
  CYAN: '\u001b[36;1m',
  GREEN: '\u001b[32;1m',
  BG_GREEN: '\u001b[30m\u001b[42m',
  YELLOW: '\u001b[33;1m',
  RESET: '\u001b[0m',
}

const STATES = {
  INITIALIZING: CHARS.MAGENTA,
  BUILDING: CHARS.CYAN,
  READY: CHARS.GREEN,
  FAILED: CHARS.RED,
  CLOSED: CHARS.BG_RED,
  INSTALLING: CHARS.YELLOW,
  COMPLETE: CHARS.BG_GREEN,
}

const COMMAND_STRIP_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const NAME_FOR_STATE = (stateValue) => Object.keys(STATES).find(key => STATES[key] === stateValue);

const STRING_TO_REGEX = (string) => new RegExp(string, 'i');

class CommandRunner {
  constructor({command, args=[], name, options, watch, install, building=[], ready=[], failed=[]}, {installer=false}={}) {
    this.command = command;
    this.args = args;
    this.name = name || command;
    this.options = options;
    this.building = building.map(STRING_TO_REGEX);
    this.ready = ready.map(STRING_TO_REGEX);
    this.failed = failed.map(STRING_TO_REGEX);
    this.watch = watch;
    this.install = install;
    this._installer = installer;
    this.state = (installer || this.install && this.install.length > 0) ? STATES.INSTALLING : STATES.INITIALIZING;
  }

  start({state, out, err, close}) {
    if (this.install && this.install.length > 0) {
      // If we have install steps, remove them off the head of the
      // queue and run them in sub-runners until none are left
      const currentInstallStep = this.install.shift();
      currentInstallStep.name = `${this.name}:${currentInstallStep.name || 'install'}`;
      const installRunner = new CommandRunner(currentInstallStep, {installer: true});
      installRunner.start({
        out: out,
        err: err,
        state: state,
        close: ({code, info}) => {
          if (code != 0) {
            close(code);
          } else {
            this.state = STATES.INITIALIZING;
            this.start({state, out, err, close});
          }
        }
      });
    } else if (!this._started) {
      this._started = true;
      this._callbacks = {state, out, err, close}
      this._propagateState();
      this._run()
      if (this.watch) {
        this._startAutoreload();
      }
    } else {
      throw new Error(`[${this.name}] has already started`)
    }
  }

  _run() {
    const {command, args, options} = this;
    this._proc = spawn(command, args, options);
    this._proc.stdout.on('data', (data) => this._out(data.toString('utf8')));
    this._proc.stderr.on('data', (data) => this._err(data.toString('utf8')));
    this._proc.on('close', (code) => this._close(code));
  }

  _startAutoreload() {
		var paths, opts = {};
    if (typeof this.watch === 'string' || Array.isArray(this.watch)) {
			paths = this.watch;
		} else {
			paths = this.watch.paths || this.watch.path;
			opts = this.watch.opts || {};
		}
    opts.ignoreInitial = true
    this.watcher = chokidar.watch([paths], opts);
		this.watcher.on('all', (info) => this._restart(info));
  }

	_restart(info) {
		this.restarted = true;
    this._out("Watched files have changed, restarting...")
		kill(this._proc.pid)
		this._run();
	}

  _propagateState() {
    const {name, state, _callbacks} = this;
    const {state: stateCallback} = _callbacks;
    stateCallback && stateCallback({name, state});
  }

  _checkUpdateState(data) {
    if (this.ready.find(regex => regex.test(data))) {
      this.state = STATES.READY;
      this._propagateState();
      return
    }
    if (this.building.find(regex => regex.test(data))) {
      this.state = STATES.BUILDING;
      this._propagateState();
      return
    }
    if (this.failed.find(regex => regex.test(data))) {
      this.state = STATES.FAILED;
      this._propagateState();
      return
    }
  }

  _out(data) {
    const {name, _callbacks} = this;
    const {out} = _callbacks;
    out && out({name, data});
    this._checkUpdateState(data);
  }

  _err(data) {
    const {name, _callbacks} = this;
    const {err} = _callbacks;
    err && err({name, data});
    this._checkUpdateState(data);
  }

  _close(code) {
		if (this.restarted) {
			this.restarted = false;
			return;
		}
    this.state = (this._installer && code === 0) ? STATES.COMPLETE : STATES.CLOSED;
    this._propagateState();
    const {name, _callbacks} = this;
    const restart = () => {
      setTimeout(() => this._run(), 1000);
    };
    const {close} = _callbacks;
    close && close({name, code, restart});
  }
}

class CommandRunnerManager {
  constructor({commands, include}) {
    this._rawCommands = commands;
    if (include && include.length > 0) {
      this._rawCommands = this._rawCommands
        .filter(command =>
          include.find(pattern =>
            minimatch(command.name, pattern) ||
            command.tags && command.tags.find(tag => minimatch(tag, pattern))
          )
        )
    }
    this._commands = this._rawCommands.map(command => new CommandRunner(command));
    this._statusLineLength = 0
  }

  start() {
    this._commands.forEach(command => command.start({
      out: (info) => this._out(info),
      err: (info) => this._err(info),
      close: (info) => this._close(info),
      state: (info) => this._state(info),
    }));
  }

  _clearStatusLines() {
    process.stdout.write(`\r${' '.repeat(this.statusLineLength)}\r`);
  }

  _logStatusLines() {
    const statuses = this._commands
      .map(({state, name}) => `${state}${name}{${NAME_FOR_STATE(state)[0].toUpperCase()}}${CHARS.RESET}`)
      .join(' ');
    const statusLine = `[${os.userInfo().username}] ${statuses}`;
    this.statusLineLength = statusLine.replace(COMMAND_STRIP_REGEX, '').length;
    process.stdout.write(statusLine);
  }

  _state({name, state}) {
    this._clearStatusLines();
    const stateString = NAME_FOR_STATE(state);
    console.log(`${state}[${name}] ${stateString.toLowerCase()}...${CHARS.RESET}`);
    this._logStatusLines();
  }

  _out({name, data}) {
    this._clearStatusLines();
    const prefix = `[${name}]`;
    const blankPrefix = ' '.repeat(prefix.length - 1);
    const [firstLine, ...lines] = data.match(/[^\r\n]+/g);
    console.log(`${prefix} ${firstLine}`);
    lines.forEach(line => console.log(`${blankPrefix}| ${line}`));
    this._logStatusLines();
  }

  _err({name, data}) {
    this._clearStatusLines();
    const prefix = `[${name}]`;
    const blankPrefix = ' '.repeat(prefix.length - 1);
    const [firstLine, ...lines] = data.match(/[^\r\n]+/g);
    console.log(`${CHARS.RED}${prefix}${CHARS.RESET} ${firstLine}`);
    lines.forEach(line => console.log(`${blankPrefix}${CHARS.RED}|${CHARS.RESET} ${line}`));
    this._logStatusLines();
  }

  _close({name, code, restart}) {
    this._clearStatusLines();
    console.log(`${CHARS.RED}[${name}]${CHARS.RESET} Command has quit unexpectdly, automatically restarting...`)
    restart();
    this._logStatusLines();
  }
}

if (require.main === module) {

  const configFile = argv.c || (fs.existsSync('./mrm.yaml') && './mrm.yaml') || './mrm.toml';
  const configString = fs.readFileSync(configFile);
  const ext = path.extname(configFile);
  const config = ext.startsWith('.t') ? toml.parse(configString) : yaml.safeLoad(configString);
	const {version} = config;

	if (version === 'exp') {
    const include = argv._.join(',').split(',').filter(arg => !!arg);
    if (include.length > 0) {
      config.include = (config.include || []).concat(include);
    }

		const manager = new CommandRunnerManager(config);
		manager.start();
	} else {
		console.error(`Unknown config version \`${version}\``);
	}
}
