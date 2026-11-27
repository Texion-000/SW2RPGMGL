/**
 * Nintendo Switch 2 Joy-Con / Pro Controller + Touchscreen input bridge
 * for Universal RPG Maker MV games (including Mano_InputConfig, Backlog, MessageSkip, etc.).
 */
import type { ViewportRect } from './browser-host';

/**
 * Standard nx.js / Web Gamepad button mapping for Nintendo Switch controllers
 * (verified against nx.js source/gamepad.cc standard_button_masks):
 *   0 = B (South)      -> cancel / escape
 *   1 = A (East)       -> ok (confirm)
 *   2 = Y (West)       -> shift (dash / item sort)
 *   3 = X (North)      -> menu
 *   4 = L              -> pageup (prev actor / backlog)
 *   5 = R              -> pagedown (next actor)
 *   6 = ZL             -> tab (plugin hotkey, e.g. Hide Message Window)
 *   7 = ZR             -> control (plugin hotkey, e.g. Hold to Skip)
 *   8 = Minus (-)      -> Loader Quick Menu (handled by overlay.ts)
 *   9 = Plus (+)       -> Reserved (exit prevented in-game)
 *  12 = D-Up           -> up
 *  13 = D-Down         -> down
 *  14 = D-Left         -> left
 *  15 = D-Right        -> right
 */
export const DEFAULT_MV_GAMEPAD_MAP: Record<number, string> = {
  0: 'cancel',
  1: 'ok',
  2: 'shift',
  3: 'menu',
  4: 'pageup',
  5: 'pagedown',
  6: 'tab',
  7: 'control',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

const STOCK_MV_GAMEPAD_SYMBOLS = new Set([
  'ok',
  'cancel',
  'shift',
  'menu',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'escape',
  'tab',
  'control',
  'debug',
]);

export interface InputBridge {
  isMinusJustPressed(): boolean;
  pollGamepadRaw(): Gamepad | null;
  setOverlayOpen(open: boolean): void;
  installIntoRuntime(runtime: Record<string, any>, getViewport: () => ViewportRect): void;
}

export function createInputBridge(): InputBridge {
  let prevMinus = false;
  let touchInstalled = false;
  let overlayOpen = false;
  let waitMenuReleaseFrames = 0;
  let resumeCooldown = 0;
  let attachedRuntime: Record<string, any> | null = null;

  /**
   * Soft-reset active Input state WITHOUT calling `Input.clear()`.
   * Calling `Input.clear()` triggers `VisuMZ_0_CoreEngine`'s `this._gamepadWait = 24`,
   * which suppresses `Input._pollGamepads()` and caused multi-second / permanent button
   * lockups after closing the Minus (-) Quick Menu!
   */
  function softResetGameInput(): void {
    const Input = attachedRuntime?.Input;
    if (Input) {
      const cs = Input._currentState;
      if (cs && typeof cs === 'object') {
        for (const k of Object.keys(cs)) cs[k] = false;
      }
      const ps = Input._previousState;
      if (ps && typeof ps === 'object') {
        for (const k of Object.keys(ps)) ps[k] = false;
      }
      Input._latestButton = null;
      Input._pressedTime = 0;
      Input._dir4 = 0;
      Input._dir8 = 0;
      Input._preferredAxis = '';
      if ('_latestKeyCode' in Input) Input._latestKeyCode = null;
      if ('_inputSpecialKeyCode' in Input) Input._inputSpecialKeyCode = undefined;
      if ('_gamepadWait' in Input) Input._gamepadWait = 0;
    }
    try { attachedRuntime?.TouchInput?.clear?.(); } catch { /* ignore */ }
  }

  function areMenuCloseButtonsHeld(): boolean {
    try {
      const pads = navigator.getGamepads?.();
      if (!pads) return false;
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        const b = pad.buttons;
        // Wait only for B (0), A (1), or Minus (8) to release — never block on D-Pad/Stick/Dash
        if (b?.[0]?.pressed || b?.[1]?.pressed || b?.[8]?.pressed) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function setOverlayOpen(open: boolean): void {
    if (overlayOpen === open) return;
    overlayOpen = open;
    (globalThis as any).__drOverlayOpen = open;
    softResetGameInput();
    if (open) {
      waitMenuReleaseFrames = 0;
      resumeCooldown = 0;
    } else {
      // Wait until A/B/Minus are released (capped at 45 frames) + 2 settle frames
      // so closing the overlay never leaks an A/B press into the game or locks up VisuMZ Input.
      waitMenuReleaseFrames = areMenuCloseButtonsHeld() ? 45 : 0;
      resumeCooldown = 2;
    }
  }

  function pollGamepadRaw(): Gamepad | null {
    try {
      const pads = navigator.getGamepads?.();
      if (!pads) return null;
      let firstConnected: Gamepad | null = null;
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        if (!firstConnected) firstConnected = pad;
        const btns = pad.buttons;
        if (btns) {
          for (let i = 0; i < btns.length; i++) {
            if (btns[i]?.pressed) return pad;
          }
        }
        const axes = pad.axes;
        if (axes && (Math.abs(axes[0] ?? 0) > 0.45 || Math.abs(axes[1] ?? 0) > 0.45)) {
          return pad;
        }
      }
      return firstConnected;
    } catch { /* ignore */ }
    return null;
  }

  function isMinusJustPressed(): boolean {
    const pad = pollGamepadRaw();
    const down = Boolean(pad?.buttons?.[8]?.pressed);
    const edge = down && !prevMinus;
    prevMinus = down;
    return edge;
  }

  function installIntoRuntime(runtime: Record<string, any>, getViewport: () => ViewportRect): void {
    attachedRuntime = runtime;
    const Input = runtime.Input;
    const TouchInput = runtime.TouchInput;
    const ConfigManager = runtime.ConfigManager;

    if (Input) {
      // Capture any custom non-stock gamepad symbols registered by game plugins (e.g. Ruins Seeker's
      // NupuConst.js: 4='L1GamePad', 5='R1GamePad', 6='L2GamePad', 7='R2GamePad', 8/9='next')
      // before installing Switch 2's standard gamepadMapper, so BOTH standard MV symbols and
      // custom plugin symbols fire simultaneously.
      const extraSymbolToButtons = new Map<string, number[]>();
      const addExtraSymbol = (sym: string, btn: number) => {
        if (!sym || btn === 8) return; // Button 8 (Minus '-') is reserved for the Loader Quick Menu
        let list = extraSymbolToButtons.get(sym);
        if (!list) {
          list = [];
          extraSymbolToButtons.set(sym, list);
        }
        if (!list.includes(btn)) list.push(btn);
      };

      const preMapper = Input.gamepadMapper;
      if (preMapper && typeof preMapper === 'object') {
        for (const [k, v] of Object.entries(preMapper)) {
          const btn = Number(k);
          const sym = typeof v === 'string' ? v.trim() : '';
          if (Number.isInteger(btn) && btn >= 0 && btn <= 15 && sym && !STOCK_MV_GAMEPAD_SYMBOLS.has(sym)) {
            // Avoid binding Hide-UI toggles (e.g. Claire's Quest CQInput.js `2: 'hideUI'`) to
            // Switch Y (button 2 = Dash), which would hide dialogue textboxes when dashing;
            // route them to ZL (button 6) instead.
            const targetBtn = (sym === 'hideUI' && btn === 2) ? 6 : btn;
            addExtraSymbol(sym, targetBtn);
          }
        }
      }
      // If the game uses Nupu action-RPG symbols (Ruins Seeker), also bind ergonomic face/Plus aliases:
      //   Y (2) -> R1GamePad (Attack/Shoot, in addition to R shoulder 5)
      //   X (3) & Plus (9) -> L2GamePad (In-game custom menu, in addition to ZL trigger 6)
      //   Plus (9) & X (3) -> next (Skip sub-message, since button 8 Minus is the Loader Quick Menu)
      if (extraSymbolToButtons.has('R1GamePad') || extraSymbolToButtons.has('L1GamePad')) {
        addExtraSymbol('R1GamePad', 2);
        addExtraSymbol('L2GamePad', 3);
        addExtraSymbol('L2GamePad', 9);
        addExtraSymbol('next', 9);
        addExtraSymbol('next', 3);
      }

      const hasOmoriGamepadMap = typeof ConfigManager?.setDefaultGamepadKeyMap === 'function';
      const OMORI_SWITCH2_GAMEPAD_MAP: Record<number, string> = {
        0: 'escape',    // Switch B (South) -> Cancel / Menu
        1: 'ok',        // Switch A (East)  -> Confirm
        2: 'shift',     // Switch Y (West)  -> Run
        3: 'tag',       // Switch X (North) -> Tag
        4: 'pageup',    // Switch L         -> LB
        5: 'pagedown',  // Switch R         -> RB
        6: 'tab',       // Switch ZL
        7: 'SEVEN7',    // Switch ZR
        8: 'SIX6',      // Reserved Minus slot placeholder for Options 1-to-1 button table
        9: 'NINE9',
        10: 'TEN10',
        11: 'ELEVEN11',
        12: 'up',
        13: 'down',
        14: 'left',
        15: 'right',
        16: 'SIXTEEN16',
      };

      if (hasOmoriGamepadMap) {
        addExtraSymbol('control', 7);
        ConfigManager.setDefaultGamepadKeyMap = function () {
          Input.gamepadMapper = { ...OMORI_SWITCH2_GAMEPAD_MAP };
        };
        if (typeof ConfigManager.setDefaultKeyboardKeyMap === 'function') {
          ConfigManager.setDefaultKeyboardKeyMap();
        }
        ConfigManager.setDefaultGamepadKeyMap();
        if ('gamepadTips' in ConfigManager) {
          ConfigManager.gamepadTips = true;
        }
      } else {
        // Apply Switch 2 gamepad mapper (overrides Mano_InputConfig default safely)
        Input.gamepadMapper = { ...DEFAULT_MV_GAMEPAD_MAP };
      }

      // Preserve Switch 2 defaults when Mano_InputConfig / Omori BASE runs ConfigManager.applyData()
      // on Scene_Boot (while still respecting explicit user remappings saved in config.rpgsave).
      if (ConfigManager && typeof ConfigManager.applyData === 'function' && !ConfigManager.__drGamepadHooked) {
        ConfigManager.__drGamepadHooked = true;
        const origApplyData = ConfigManager.applyData;
        ConfigManager.applyData = function (config: Record<string, any>) {
          const res = origApplyData.call(this, config);
          if (hasOmoriGamepadMap) {
            if (!config || !config.gamepadInputMap) {
              Input.gamepadMapper = { ...OMORI_SWITCH2_GAMEPAD_MAP };
            }
            if (!config || config.gamepadTips === undefined) {
              this.gamepadTips = true;
            }
            return res;
          }
          if (!config || !config.GAMEPAD_CONFIG) {
            Input.gamepadMapper = { ...DEFAULT_MV_GAMEPAD_MAP };
          } else {
            // Ensure D-Pad directions remain mapped even on imported configs
            Input.gamepadMapper[12] = Input.gamepadMapper[12] || 'up';
            Input.gamepadMapper[13] = Input.gamepadMapper[13] || 'down';
            Input.gamepadMapper[14] = Input.gamepadMapper[14] || 'left';
            Input.gamepadMapper[15] = Input.gamepadMapper[15] || 'right';
          }
          return res;
        };
      }

      // Ensure tab (9) and control (17) are recognized in Input.keyMapper too
      if (Input.keyMapper) {
        Input.keyMapper[9] = 'tab';
        Input.keyMapper[17] = 'control';
        Input.keyMapper[88] = 'escape';
      }

      // Bridge keyboard-only plugin helpers (e.g. Forbidden Orders GBCCoffee_MegyUtils/MegyDialogue
      // `Input.isKeycodeTriggered(13)` on Window_ChoiceList, YEP_KeyNameEntry `Input.isSpecialCode`
      // & `Input.isArrowPressed`, and Claire's Quest custom scenes checking `Input.isTriggered('escape')`)
      // so Switch Joy-Con / Pro Controller ABXY & D-Pad buttons always work seamlessly.
      if (typeof Input.isKeycodeTriggered === 'function' && !Input.__drKeycodeWrapped) {
        Input.__drKeycodeWrapped = true;
        const origKeycodeTriggered = Input.isKeycodeTriggered;
        Input.isKeycodeTriggered = function (keyCode: number) {
          if (origKeycodeTriggered.call(this, keyCode)) return true;
          switch (keyCode) {
            case 13:
            case 32:
            case 90:
              return Boolean(this.isTriggered('ok'));
            case 27:
            case 88:
              return Boolean(this.isTriggered('cancel') || this.isTriggered('menu'));
            case 16:
              return Boolean(this.isTriggered('shift'));
            case 17:
              return Boolean(this.isTriggered('control'));
            case 9:
            case 72:
              return Boolean(this.isTriggered('tab'));
            case 37:
              return Boolean(this.isTriggered('left'));
            case 38:
              return Boolean(this.isTriggered('up'));
            case 39:
              return Boolean(this.isTriggered('right'));
            case 40:
              return Boolean(this.isTriggered('down'));
            default:
              return false;
          }
        };
      }

      if (typeof Input.isSpecialCode === 'function' && !Input.__drSpecialCodeWrapped) {
        Input.__drSpecialCodeWrapped = true;
        const origIsSpecial = Input.isSpecialCode;
        Input.isSpecialCode = function (key: string) {
          if (origIsSpecial.call(this, key)) return true;
          if (typeof key === 'string') {
            if (/enter/i.test(key)) return Boolean(this.isTriggered('ok'));
            if (/escape/i.test(key)) return Boolean(this.isTriggered('cancel') || this.isTriggered('menu'));
            if (/backspace/i.test(key)) return Boolean(this.isTriggered('cancel'));
          }
          return false;
        };
      }

      if (typeof Input.isArrowPressed === 'function' && !Input.__drArrowWrapped) {
        Input.__drArrowWrapped = true;
        const origIsArrow = Input.isArrowPressed;
        Input.isArrowPressed = function () {
          if (origIsArrow.call(this)) return true;
          return Boolean(
            this.isPressed('left') || this.isPressed('up') ||
            this.isPressed('right') || this.isPressed('down'),
          );
        };
      }

      if (typeof Input.isTriggered === 'function' && !Input.__drEscapeAliasWrapped) {
        Input.__drEscapeAliasWrapped = true;
        const origIsTriggered = Input.isTriggered;
        Input.isTriggered = function (keyName: string) {
          if (origIsTriggered.call(this, keyName)) return true;
          if (keyName === 'escape') {
            const scene = runtime.SceneManager?._scene;
            const onMap = Boolean(runtime.Scene_Map && scene instanceof runtime.Scene_Map);
            if (!onMap && this._latestButton === 'cancel' && this._pressedTime === 0) {
              return true;
            }
          }
          return false;
        };
      }

      const GAMEPAD_SYM_TO_KEYCODE: Record<string, number> = {
        ok: 13,
        cancel: 27,
        menu: 27,
        shift: 16,
        control: 17,
        tab: 72,
        left: 37,
        up: 38,
        right: 39,
        down: 40,
      };

      // Advance overlay-resume cooldown once per frame in Input.update (never inside _updateGamepadState)
      // and clear VisuMZ_0_CoreEngine's `_gamepadWait` so gamepad polling never stalls after overlay close.
      if (typeof Input.update === 'function' && !Input.__drUpdateWrapped) {
        Input.__drUpdateWrapped = true;
        const origInputUpdate = Input.update;
        Input.update = function () {
          if (overlayOpen) {
            softResetGameInput();
            return;
          }
          if (waitMenuReleaseFrames > 0 || resumeCooldown > 0) {
            if ('_gamepadWait' in this && this._gamepadWait > 0) {
              this._gamepadWait = 0;
            }
            if (waitMenuReleaseFrames > 0) {
              if (!areMenuCloseButtonsHeld()) {
                waitMenuReleaseFrames = 0;
              } else {
                waitMenuReleaseFrames--;
              }
            } else if (resumeCooldown > 0) {
              resumeCooldown--;
            }
          }
          return origInputUpdate.call(this);
        };
      }

      // Wrap _updateGamepadState so Left Stick + ZL/ZR/L/R + custom plugin symbols always register smoothly
      // and suppress all in-game gamepad input while the Minus (-) Quick Menu is open or settling.
      const origUpdate = Input._updateGamepadState?.bind(Input);
      if (origUpdate && !Input.__drPatched) {
        Input.__drPatched = true;
        Input._updateGamepadState = function (gamepad: Gamepad) {
          // Keep Switch Minus (button 8) exclusive to the Quick Menu even if a plugin (e.g. NEO_InputConfig)
          // overwrote Input.gamepadMapper on Scene_Boot.start and bound 8:'tab' while leaving ZL (6) blank.
          const gm = this.gamepadMapper;
          if (gm && gm[8] && gm[8] !== 'SIX6') {
            if (!gm[6]) gm[6] = gm[8];
            delete gm[8];
          }
          if (gm && gm[7] === '') {
            gm[7] = 'control';
          }

          if (overlayOpen || waitMenuReleaseFrames > 0 || resumeCooldown > 0) {
            const btns = gamepad?.buttons;
            if (btns && this._gamepadStates) {
              const sync: boolean[] = [];
              for (let i = 0; i < btns.length; i++) {
                sync[i] = i === 8 ? false : Boolean(btns[i]?.pressed);
              }
              this._gamepadStates[gamepad.index] = sync;
            }
            const cs = this._currentState;
            if (cs && typeof cs === 'object') {
              for (const k of Object.keys(cs)) cs[k] = false;
            }
            this._latestButton = null;
            this._pressedTime = 0;
            if ('_gamepadWait' in this) this._gamepadWait = 0;
            return;
          }
          const prevRaw = this._gamepadStates?.[gamepad.index];
          const prevState = Array.isArray(prevRaw) ? prevRaw.slice() : [];
          origUpdate(gamepad);
          const state = this._gamepadStates?.[gamepad.index];
          // Never allow physical button 8 (Minus) to trigger OMORI placeholder 'SIX6' in-game
          if (state && state.length > 8 && state[8]) {
            state[8] = false;
            if (gm?.[8] && this._currentState) {
              this._currentState[gm[8]] = false;
              if (this._latestButton === gm[8]) this._latestButton = null;
            }
          }
          if (gamepad?.axes && state) {
            const threshold = 0.45;
            const ax = gamepad.axes[0] ?? 0;
            const ay = gamepad.axes[1] ?? 0;
            const setDir = (idx: number, pressed: boolean, sym: string) => {
              const prev = Boolean(state[idx]);
              if (pressed !== prev) {
                state[idx] = pressed;
                this._currentState[sym] = pressed;
              }
            };
            // Only drive directions from stick when D-Pad isn't overriding
            const dpadAny = Boolean(
              gamepad.buttons[12]?.pressed || gamepad.buttons[13]?.pressed ||
              gamepad.buttons[14]?.pressed || gamepad.buttons[15]?.pressed,
            );
            if (!dpadAny) {
              setDir(14, ax < -threshold, 'left');
              setDir(15, ax > threshold, 'right');
              setDir(12, ay < -threshold, 'up');
              setDir(13, ay > threshold, 'down');
            }
          }
          // Mirror newly pressed gamepad buttons into _latestKeyCode / _inputSpecialKeyCode
          // for plugins that inspect keyboard keyCodes directly (e.g. GBCCoffee_MegyUtils, YEP_KeyNameEntry).
          if (state) {
            for (let i = 0; i < state.length; i++) {
              if (state[i] && !prevState[i]) {
                const sym = this.gamepadMapper?.[i];
                const kc = sym ? GAMEPAD_SYM_TO_KEYCODE[sym] : undefined;
                if (kc !== undefined) {
                  if ('_latestKeyCode' in this) this._latestKeyCode = kc;
                  if ('_inputSpecialKeyCode' in this) this._inputSpecialKeyCode = kc;
                }
              }
            }
          }
          if (state && extraSymbolToButtons.size > 0) {
            for (const [sym, btns] of extraSymbolToButtons.entries()) {
              let wasDown = false;
              let isDown = false;
              for (let i = 0; i < btns.length; i++) {
                const idx = btns[i];
                if (prevState[idx]) wasDown = true;
                if (state[idx]) isDown = true;
              }
              if (isDown !== wasDown) {
                this._currentState[sym] = isDown;
              }
            }
          }
          // Ensure plugins that check global GamePadOn (e.g. Ruins Seeker NupuSetting.js)
          // switch to gamepad mode on any D-Pad or face/shoulder button press, not just analog stick tilt.
          if (state && 'GamePadOn' in runtime && !runtime.GamePadOn) {
            for (let i = 0; i < state.length; i++) {
              if (i !== 8 && state[i]) {
                runtime.GamePadOn = true;
                break;
              }
            }
          }
        };
      }
    }

    // Wire Switch 2 touchscreen events to RPG Maker MV & MZ TouchInput with dynamic viewport coord mapping.
    // IMPORTANT: In nx.js, touch events are dispatched on `screen` (and `screen.addEventListener('touchstart', ...)`
    // is what calls `$.hidInitializeTouchScreen()`!). Listening only on `globalThis` never activates touch.
    const touchTarget: any =
      typeof (globalThis as any).screen?.addEventListener === 'function'
        ? (globalThis as any).screen
        : typeof globalThis.addEventListener === 'function'
          ? globalThis
          : null;

    if (TouchInput && !touchInstalled && touchTarget) {
      touchInstalled = true;
      const mapCoords = (touch: any) => {
        const clientX = Number(touch?.clientX ?? touch?.pageX ?? touch?.x ?? 0);
        const clientY = Number(touch?.clientY ?? touch?.pageY ?? touch?.y ?? 0);
        const vp = getViewport();
        const x = Math.round(((clientX - vp.x) / Math.max(1, vp.w)) * vp.gw);
        const y = Math.round(((clientY - vp.y) / Math.max(1, vp.h)) * vp.gh);
        return { x, y, gw: vp.gw, gh: vp.gh };
      };
      const clampCoords = (x: number, y: number, gw: number, gh: number) => ({
        x: Math.max(0, Math.min(Math.max(0, gw - 1), x)),
        y: Math.max(0, Math.min(Math.max(0, gh - 1), y)),
      });

      touchTarget.addEventListener('touchstart', (ev: any) => {
        if (overlayOpen || resumeCooldown > 0) return;
        const t = ev.changedTouches?.[0] ?? ev.touches?.[0];
        if (!t) return;
        const { x, y, gw, gh } = mapCoords(t);
        if (x >= 0 && y >= 0 && x <= gw && y <= gh) {
          TouchInput._screenPressed = true;
          TouchInput._pressedTime = 0;
          if ((ev.touches?.length ?? 0) >= 2) {
            TouchInput._onCancel?.(x, y);
          } else {
            TouchInput._onTrigger?.(x, y);
          }
        }
      });

      touchTarget.addEventListener('touchmove', (ev: any) => {
        if (overlayOpen || resumeCooldown > 0) return;
        const t = ev.changedTouches?.[0] ?? ev.touches?.[0];
        if (!t) return;
        const raw = mapCoords(t);
        const { x, y } = clampCoords(raw.x, raw.y, raw.gw, raw.gh);
        TouchInput._onMove?.(x, y);
      });

      const handleTouchEnd = (ev: any) => {
        const remaining = ev.touches?.length ?? 0;
        if (remaining === 0) {
          TouchInput._screenPressed = false;
        }
        if (overlayOpen || resumeCooldown > 0) return;
        const t = ev.changedTouches?.[0];
        if (!t) return;
        const raw = mapCoords(t);
        const { x, y } = clampCoords(raw.x, raw.y, raw.gw, raw.gh);
        TouchInput._onRelease?.(x, y);
      };

      touchTarget.addEventListener('touchend', handleTouchEnd);
      touchTarget.addEventListener('touchcancel', handleTouchEnd);
    }
  }

  return { isMinusJustPressed, pollGamepadRaw, setOverlayOpen, installIntoRuntime };
}
