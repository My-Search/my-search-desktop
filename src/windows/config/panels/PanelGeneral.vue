<script setup lang="ts">
/**
 * 常规设置面板（收纳与搜索/订阅无关的通用开关）。
 *
 * 目前只有一项：开机自启动。桌面版本质是「常驻托盘的呼出工具」，
 * 因此**默认开机自启**（Rust 端首次运行即写入系统启动项），
 * 用户可在这里随时关闭——开关直接反映系统里的真实状态。
 */
import { onMounted, ref } from "vue";
import { getAutostartEnabled, setAutostartEnabled } from "../../../lib/tauri-bridge";

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
}>();

/** 系统里当前是否已启用开机自启动 */
const enabled = ref(false);
/** 首次读取状态中（避免开关先显示关闭再跳到开启的闪烁） */
const loading = ref(true);
/** 正在写入（写入期间禁用开关，避免连点产生并发写注册表） */
const saving = ref(false);

/** 读取一次系统真实状态 */
async function refresh(): Promise<void> {
  try {
    enabled.value = await getAutostartEnabled();
  } catch (e) {
    console.warn("读取开机自启动状态失败:", e);
  } finally {
    loading.value = false;
  }
}

/** 切换开关：先乐观更新，失败则回滚并提示 */
async function toggle(): Promise<void> {
  if (saving.value || loading.value) return;
  const next = !enabled.value;
  saving.value = true;
  enabled.value = next;
  try {
    await setAutostartEnabled(next);
    props.notify(next ? "已开启开机自启动。" : "已关闭开机自启动。", "ok");
  } catch (e) {
    enabled.value = !next;
    props.notify((e as Error)?.message ?? "设置开机自启动失败", "error");
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await refresh();
});
</script>

<template>
  <section class="page general">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>常规设置</h3>
      </div>
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">开机自启动</span>
          <span class="general-desc">
            登录系统后自动启动我的搜索并常驻托盘，按下呼出快捷键即可使用
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: enabled, disabled: loading || saving }"
          title="开机自启动（默认开启，可随时关闭）"
        >
          <input
            type="checkbox"
            data-act="autostart"
            :checked="enabled"
            :disabled="loading || saving"
            @change="toggle"
          />
          <span class="switch-track" aria-hidden="true">
            <span class="switch-thumb"></span>
          </span>
        </label>
      </div>
      <div class="cfg-note">
        默认开启：安装后随系统登录自动启动，常驻托盘，保证呼出快捷键随时可用。
        关闭后仍可通过开始菜单手动启动，也可随时回到这里重新开启。
      </div>
    </div>
  </section>
</template>
