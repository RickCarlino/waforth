import wasmModule from "../waforth.wat";

const isSafari =
  typeof navigator != "undefined" &&
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const PAD_OFFSET = 400;

// eslint-disable-next-line no-unused-vars
const arrayToBase64 =
  typeof Buffer === "undefined"
    ? function arrayToBase64(bytes: Uint8Array) {
        var binary = "";
        var len = bytes.byteLength;
        for (var i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
      }
    : function arrayToBase64(s: Uint8Array) {
        return Buffer.from(s).toString("base64");
      };

function loadString(memory: WebAssembly.Memory, addr: number, len: number) {
  return String.fromCharCode.apply(
    null,
    new Uint8Array(memory.buffer, addr, len) as any
  );
}

function saveString(s: string, memory: WebAssembly.Memory, addr: number) {
  const len = s.length;
  const a = new Uint8Array(memory.buffer, addr, len);
  for (let i = 0; i < len; ++i) {
    a[i] = s.charCodeAt(i);
  }
}

/**
 * JavaScript shell around the WAForth WebAssembly module.
 *
 * Provides higher-level functions to interact with the WAForth WebAssembly module.
 *
 * To the WebAssembly module, provides the infrastructure to dynamically load WebAssembly modules and
 * the I/O primitives with the UI.
 * */
class WAForth {
  core?: WebAssembly.Instance;
  #buffer?: number[];
  #fns: Record<string, (f: WAForth) => void>;

  /**
   * Callback that is called when a character needs to be emitted.
   *
   * `c` is the ASCII code of the character to be emitted.
   */
  onEmit?: (c: string) => void;

  constructor() {
    this.#fns = {};
    this.onEmit = (() => {
      // Default emit that logs to console
      let buffer: string[] = [];
      return (c: string) => {
        if (c === "\n") {
          console.log(buffer.join(""));
          buffer = [];
        } else {
          buffer.push(c);
        }
      };
    })();
  }

  /**
   * Initialize WAForth.
   *
   * Needs to be called before interpret().
   */
  async load() {
    let table: WebAssembly.Table;
    let memory: WebAssembly.Memory;
    const buffer = (this.#buffer = []);

    const instance = await WebAssembly.instantiate(wasmModule, {
      shell: {
        ////////////////////////////////////////
        // I/O
        ////////////////////////////////////////

        emit: (c: number) => {
          if (this.onEmit) {
            this.onEmit(String.fromCharCode(c));
          }
        },

        getc: () => {
          if (buffer.length === 0) {
            return -1;
          }
          return buffer.pop();
        },

        debug: (d: number) => {
          console.log("DEBUG: ", d, String.fromCharCode(d));
        },

        key: () => {
          let c: string | null = null;
          while (c == null || c == "") {
            c = window.prompt("Enter character");
          }
          return c.charCodeAt(0);
        },

        accept: (p: number, n: number) => {
          const input = (window.prompt("Enter text") || "").substring(0, n);
          const target = new Uint8Array(memory.buffer, p, input.length);
          for (let i = 0; i < input.length; ++i) {
            target[i] = input.charCodeAt(i);
          }
          console.log("ACCEPT", p, n, input.length);
          return input.length;
        },

        ////////////////////////////////////////
        // Loader
        ////////////////////////////////////////

        load: (offset: number, length: number, index: number) => {
          let data = new Uint8Array(
            (this.core!.exports.memory as WebAssembly.Memory).buffer,
            offset,
            length
          );
          if (isSafari) {
            // On Safari, using the original Uint8Array triggers a bug.
            // Taking an element-by-element copy of the data first.
            let dataCopy = [];
            for (let i = 0; i < length; ++i) {
              dataCopy.push(data[i]);
            }
            data = new Uint8Array(dataCopy);
          }
          if (index >= table.length) {
            table.grow(table.length); // Double size
          }
          // console.log("Load", index, arrayToBase64(data));
          try {
            var module = new WebAssembly.Module(data);
            new WebAssembly.Instance(module, {
              env: { table, memory },
            });
          } catch (e) {
            console.error(e);
            throw e;
          }
        },

        ////////////////////////////////////////
        // Generic call
        ////////////////////////////////////////

        call: () => {
          const len = this.pop();
          const addr = this.pop();
          const fname = loadString(memory, addr, len);
          const fn = this.#fns[fname];
          if (!fn) {
            console.error("Unbound SCALL: %s", fname);
          } else {
            fn(this);
          }
        },
      },
    });
    this.core = instance.instance;
    table = this.core.exports.table as WebAssembly.Table;
    memory = this.core.exports.memory as WebAssembly.Memory;
  }

  memory(): WebAssembly.Memory {
    return this.core!.exports.memory as WebAssembly.Memory;
  }

  here(): number {
    return (this.core!.exports.here as any)() as number;
  }

  pop(): number {
    return (this.core!.exports.pop as any)();
  }

  popString(): string {
    const len = this.pop();
    const addr = this.pop();
    return loadString(this.memory(), addr, len);
  }

  push(n: number): void {
    (this.core!.exports.push as any)(n);
  }

  pushString(s: string, offset = 0): number {
    const addr = this.here() + PAD_OFFSET;
    saveString(s, this.memory(), addr);
    this.push(addr);
    this.push(s.length);
    return addr + PAD_OFFSET;
  }

  /**
   * Read data `s` into the input buffer without interpreting it.
   */
  read(s: string) {
    const data = new TextEncoder().encode(s);
    for (let i = data.length - 1; i >= 0; --i) {
      this.#buffer!.push(data[i]);
    }
  }

  /**
   * Read data `s` into the input buffer, and interpret.
   */
  interpret(s: string) {
    this.read(s);
    try {
      return (this.core!.exports.interpret as any)();
    } catch (e) {
      // Exceptions thrown from the core means QUIT or ABORT is called, or an error
      // has occurred. Assume what has been done has been done, and ignore here.
    }
  }

  /**
   * Bind `name` to SCALL in Forth.
   *
   * When an SCALL is done with `name` on the top of the stack, `fn` will be called (with the name popped off the stack).
   * Use `stack` to pop parameters off the stack, and push results back on the stack.
   */
  bind(name: string, fn: (f: WAForth) => void) {
    this.#fns[name] = fn;
  }

  /**
   * Bind async `name` to SCALL in Forth.
   *
   * When an SCALL is done with `name` on the top of the stack, `fn` will be called (with the name popped off the stack).
   * Expects an execution token on the top of the stack, which will be called when the async callback is finished.
   * The execution parameter will be called with the success flag set.
   */
  bindAsync(name: string, fn: (f: WAForth) => Promise<void>) {
    this.#fns[name] = async () => {
      const cbxt = this.pop();
      try {
        await fn(this);
        this.push(-1);
      } catch (e) {
        console.error(e);
        this.push(0);
      } finally {
        this.push(cbxt);
        this.interpret("EXECUTE");
      }
    };
  }
}

export default WAForth;
