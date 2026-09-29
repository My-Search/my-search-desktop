/**
 * 「选择环境变量」授权弹层 —— 宿主绘制的居中面板（类微信授权）。
 *
 * 为什么由宿主画而不是插件自己画：
 *   1. **统一观感**：所有插件同一套交互，用户只需理解一次；
 *   2. **授权发生在宿主的对话框里**：插件无法伪造「已授权」，用户看到的是
 *      宿主确认的原话（谁、要用哪个变量）；
 *   3. **值不出现在插件可读的 DOM 里**：面板只显示名字与用途说明，
 *      因此即使 inlay 不是沙箱（插件与宿主同 window），也抓不到明文。
 *
 * 用法（配合 EnvPicker.vue）：
 *   const picker = useEnvPicker();
 *   // 组件里 <EnvPicker :state="picker.state" @ok="picker.handleOk" @cancel="picker.handleCancel" />
 *   const r = await picker.openEnvPicker({ pluginId, pluginName, purpose });
 */
import { reactive } from "vue";

/** 选择结果：引用某个变量 / 手工输入字面量 */
export type EnvPickResult =
  | { kind: "ref"; name: string; ref: string }
  | { kind: "literal"; value: string };

export interface EnvPickerOptions {
  /** 发起选择的插件 id（授权记录要写进它的 grants） */
  pluginId?: string;
  /** 插件显示名（面板标题与授权确认文案里用） */
  pluginName?: string;
  /** 一句话说明这次选择的用途（如「该提供商的 API Key 将引用此变量」） */
  purpose?: string;
  /** 已授权的变量名（宿主已知状态） */
  granted?: string[];
  /** 弹层标题（缺省「选择环境变量」） */
  title?: string;
  /**
   * 用户点「允许」时的授权回调（宿主实现：写注册表 + 下发网关 + 必要时重启进程）。
   * 返回 false 表示授权未生效，弹层保持未授权状态。
   */
  grant?: (name: string) => Promise<boolean>;
}

export interface EnvPickerState {
  visible: boolean;
  pluginId: string;
  pluginName: string;
  purpose: string;
  title: string;
  /** 已授权变量名（打开时快照；授权成功后就地追加） */
  granted: string[];
}

export function useEnvPicker() {
  const state = reactive<EnvPickerState>({
    visible: false,
    pluginId: "",
    pluginName: "",
    purpose: "",
    title: "选择环境变量",
    granted: [],
  });

  let resolver: ((value: EnvPickResult | null) => void) | null = null;
  /** 授权回调（打开时由调用方注入；组件通过 grantClient() 取用） */
  let grantFn: ((name: string) => Promise<boolean>) | null = null;

  /** 打开选择器；点「取消」/Esc 返回 null */
  function openEnvPicker(opts: EnvPickerOptions = {}): Promise<EnvPickResult | null> {
    return new Promise((resolve) => {
      resolver = resolve;
      grantFn = opts.grant ?? null;
      state.pluginId = String(opts.pluginId ?? "");
      state.pluginName = String(opts.pluginName ?? "");
      state.purpose = String(opts.purpose ?? "");
      state.title = String(opts.title ?? "选择环境变量");
      state.granted = [...(opts.granted ?? [])];
      state.visible = true;
    });
  }

  /** 关闭并回传结果（组件事件 / 键盘共用） */
  function closePick(result: EnvPickResult | null): void {
    state.visible = false;
    const resolve = resolver;
    resolver = null;
    grantFn = null;
    if (resolve) resolve(result);
  }

  /** 取授权回调（组件在用户点「允许」时调用） */
  function grantClient(): ((name: string) => Promise<boolean>) | null {
    return grantFn;
  }

  /** 授权成功后由宿主同步已授权列表（面板徽章立即更新） */
  function markGranted(name: string): void {
    if (!state.granted.includes(name)) state.granted = [...state.granted, name];
  }

  return {
    state,
    openEnvPicker,
    grantClient,
    markGranted,
    handleOk: (r: EnvPickResult) => closePick(r),
    handleCancel: () => closePick(null),
  };
}

export type EnvPickerApi = ReturnType<typeof useEnvPicker>;
