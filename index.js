#!/usr/bin/env node

const {spawn} = require('child_process');
const fs = require('fs');
const {argv} = require('yargs');
const toml = require('toml');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const CHARS = {
  RED: '\u001b[31;1m',
  DARK_RED: '\u001b[31;1m',
  MAGENTA: '\u001b[35;1m',
  CYAN: '\u001b[36;1m',
  GREEN: '\u001b[32;1m',
  RESET: '\u001b[0m',
}

const STATES = {
  INITIALIZING: CHARS.MAGENTA,
  BUILDING: CHARS.CYAN,
  READY: CHARS.GREEN,
  FAILED: CHARS.RED,
  CLOSED: CHARS.DARK_RED,
}

const COMMAND_STRIP_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const NAME_FOR_STATE = (stateValue) => Object.keys(STATES).find(key => STATES[key] === stateValue);

const STRING_TO_REGEX = (string) => new RegExp(string, 'i');

class CommandRunner {
  constructor({command, args=[], name, options, building=[], ready=[], failed=[]}) {
    this.command = command;
    this.args = args;
    this.name = name || command;
    this.options = options;
    this.building = building.map(STRING_TO_REGEX);
    this.ready = ready.map(STRING_TO_REGEX);
    this.failed = failed.map(STRING_TO_REGEX);
    this.state = STATES.INITIALIZING;
  }

  start({state, out, err, close}) {
    if (!this._started) {
      this._started = true;
      this._callbacks = {state, out, err, close}
      this._propagateState();
      this._run()
    } else {
      throw new Error(`[${this.name}] has already started`)
    }
  }

  _run() {
    const {command, args} = this;
    this._proc = spawn(command, args, this.options);
    this._proc.stdout.on('data', (data) => this._out(data.toString('utf8')));
    this._proc.stderr.on('data', (data) => this._err(data.toString('utf8')));
    this._proc.on('close', (code) => this._close(code));
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
    this.state = STATES.CLOSED;
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
  constructor({commands}) {
    this._commands = commands.map(command => new CommandRunner(command));
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
    console.log(`${CHARS.RED}[${name}]${CHARS.RESET} has quit unexpectdly, automatically restarting...`)
    restart();
    this._logStatusLines();
  }
}

if (require.main === module) {
  const configFile = argv.c || (fs.existsSync('./mrm.yaml') && './mrm.yaml') || './mrm.toml';
  const configString = fs.readFileSync(configFile);
  const ext = path.extname(configFile);
  const config = ext.startsWith('.t') ? toml.parse(configString) : yaml.safeLoad(configString);

  const manager = new CommandRunnerManager(config);
  manager.start();
}
