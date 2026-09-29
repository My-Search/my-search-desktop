<script setup lang="ts">
/**
 * 环境变量面板 —— 一份集中配置，多插件共用。
 *
 * 这里是**唯一能看见变量明文**的地方：插件自己的界面（内嵌在搜索窗里的 inlay）
 * 从不渲染变量值，只显示名字与用途说明，因此密钥不会被插件脚本从 DOM 里读走。
 *
 * 授权不在本面板做：本面板只维护「有哪些变量」；「某个插件能不能用某个变量」
 * 在「插件」面板里逐项授权（或在插件配置界面的选择器里当场授权）。
 *
 * 保存即生效：写 localStorage 后调 `rt.syncEnvToPlugins()` 把新 env 下发到
 * 网关镜像，并重启正在运行的后台进程——变量值只在 spawn 时进入进程环境。
 */
import { computed, onMounted, ref } from "vue";
import CfgHint from "./CfgHint.vue";
import {
  type EnvVar,
  ENV_NAME_RE,
  MASKED_VALUE,
  RESERVED_ENV_PREFIX,
  isReservedEnvName,
  loadEnvVars,
  removeEnvVar,
  upsertEnvVar,
} from "../../../lib/plugins/env-store";
import { usePluginRuntime } from "../usePluginRuntime";

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
  confirm: (text: string) => Promise<boolean>;
}>();

const rt = usePluginRuntime();

/** 当前变量列表 */
const items = ref<EnvVar[]>([]);
/** 搜索关键词（按名字/描述过滤） */
const keyword = ref("");
/** 已展开明文的值名集合（不持久化，切换面板即收起） */
const revealed = ref<Set<string>>(new Set());
/** 正在编辑的变量名（null = 未编辑；"__new__" = 新增） */
const editing = ref<string | null>(null);
/** 正在写入（避免连点产生并发写） */
const saving = ref(false);

/** 编辑表单 */
const form = ref({ name: "", value: "", description: "", secret: true });
/** 名字校验错误（中文文案） */
const nameError = ref("");

const NEW = "__new__";

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return items.value;
  return items.value.filter(
    (v) =>
      v.name.toLowerCase().includes(kw) ||
      String(v.description ?? "").toLowerCase().includes(kw)
  );
});

function refresh(): void {
  items.value = loadEnvVars();
}

function valueText(v: EnvVar): string {
  if (v.value === "") return "（空）";
  if (v.secret === false) return v.value;
  return revealed.value.has(v.name) ? v.value : MASKED_VALUE;
}

function toggleReveal(name: string): void {
  const next = new Set(revealed.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  revealed.value = next;
}

function startNew(): void {
  editing.value = NEW;
  form.value = { name: "", value: "", description: "", secret: true };
  nameError.value = "";
}

function startEdit(v: EnvVar): void {
  editing.value = v.name;
  form.value = {
    name: v.name,
    value: v.value,
    description: String(v.description ?? ""),
    secret: v.secret !== false,
  };
  nameError.value = "";
  // 编辑时默认显示明文，免得用户「看不到自己在改什么」而误覆盖
  if (v.secret !== false) {
    const next = new Set(revealed.value);
    next.add(v.name);
    revealed.value = next;
  }
}

function cancelEdit(): void {
  editing.value = null;
  nameError.value = "";
}

/** 校验名字：格式 + 保留名 + 唯一性（改名时排除自己） */
function validateName(): boolean {
  const name = form.value.name.trim();
  if (!name) {
    nameError.value = "请输入变量名";
    return false;
  }
  if (isReservedEnvName(name)) {
    nameError.value = `不能以 ${RESERVED_ENV_PREFIX} 开头（宿主保留，用于标识插件进程）`;
    return false;
  }
  if (!ENV_NAME_RE.test(name)) {
    nameError.value = "变量名只能包含字母、数字、下划线，且不能以数字开头";
    return false;
  }
  const duplicate = items.value.some((v) => v.name === name && v.name !== editing.value);
  if (duplicate) {
    nameError.value = `已存在同名变量「${name}」`;
    return false;
  }
  nameError.value = "";
  return true;
}

async function save(): Promise<void> {
  if (saving.value) return;
  if (!validateName()) return;
  saving.value = true;
  try {
    const name = form.value.name.trim();
    const isRename = editing.value !== null && editing.value !== NEW && editing.value !== name;
    if (isRename && editing.value) {
      // 改名 = 删旧 + 建新（保留值/说明；授权记录按名字绑定，因此改名后需重新授权）
      removeEnvVar(editing.value);
    }
    items.value = upsertEnvVar({
      name,
      value: form.value.value,
      description: form.value.description.trim() || undefined,
      secret: form.value.secret,
    });
    editing.value = null;
    await rt.syncEnvToPlugins();
    props.notify(isRename ? `已重命名为「${name}」，插件需重新授权该变量。` : `已保存环境变量「${name}」。`, "ok");
  } catch (e) {
    props.notify(`保存失败：${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    saving.value = false;
  }
}

async function remove(v: EnvVar): Promise<void> {
  const granted = countGrants(v.name);
  const extra = granted > 0 ? `\n\n已有 ${granted} 个插件获得过该变量的授权，删除后它们的引用会失效。` : "";
  if (!(await props.confirm(`确定删除环境变量「${v.name}」吗？${extra}`))) return;
  if (editing.value === v.name) cancelEdit();
  items.value = removeEnvVar(v.name);
  await rt.syncEnvToPlugins();
  props.notify(`已删除环境变量「${v.name}」。`, "ok");
}

/** 有多少插件已授权该变量（面板上给用户一个「影响面」提示） */
function countGrants(name: string): number {
  let n = 0;
  for (const rec of rt.registry.plugins) {
    if (rec.grants.some((g) => g.permission === `env.read:${name}`)) n++;
  }
  return n;
}

function grantedCount(name: string): number {
  return countGrants(name);
}

onMounted(refresh);
</script>

<template>
  <section class="page env">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>环境变量</h3>
        <span class="cfg-hint">所有插件共用这一份配置；插件只能用你逐项授权的变量</span>
      </div>
      <details class="env-note-wrap">
        <summary>说明与安全提示</summary>
        <p class="cfg-note env-note">
          在这里集中维护密钥与通用变量（如 API Key、代理地址），插件配置里直接引用变量名即可，
          不必在每个插件里各存一份。<b>未授权的变量对插件既不可见，也不会注入它的后台进程</b>；
          授权在「插件」面板里逐项进行。<br />
          变量值以明文保存并随「备份与同步」一起走（与 GitHub Token 同级别），
          请不要在这里存放你无法接受落盘的东西。
        </p>
      </details>

      <div class="env-toolbar">
        <input
          v-model="keyword"
          class="cfg-input env-search"
          type="text"
          placeholder="搜索变量名 / 说明"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="cfg-btn primary" :disabled="editing === NEW" @click="startNew">新增变量</button>
      </div>
    </div>

    <div class="cfg-card env-list-card">
      <div class="cfg-card-head">
        <h3>变量列表</h3>
        <span class="cfg-hint">共 {{ items.length }} 项</span>
      </div>

      <!-- 新增 / 编辑表单 -->
      <div v-if="editing !== null" class="env-form">
        <div class="cfg-row">
          <span class="cfg-row-label">变量名</span>
          <input
            v-model="form.name"
            class="cfg-input"
            :class="{ 'is-invalid': !!nameError }"
            type="text"
            placeholder="例如 OPENAI_API_KEY"
            spellcheck="false"
            autocomplete="off"
            :disabled="editing !== NEW"
            @input="nameError = ''"
          />
        </div>
        <div v-if="nameError" class="env-error">{{ nameError }}</div>
        <div class="cfg-row">
          <span class="cfg-row-label">值</span>
          <input
            v-model="form.value"
            class="cfg-input env-value-input"
            :type="form.secret ? 'password' : 'text'"
            placeholder="变量值"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="cfg-row">
          <span class="cfg-row-label">说明</span>
          <input
            v-model="form.description"
            class="cfg-input"
            type="text"
            placeholder="可选：这个变量是干什么用的（插件选择器里会显示）"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="cfg-row">
          <span class="cfg-row-label">按密钥处理</span>
          <label class="switch env-secret-switch" title="开启后列表中默认掩码显示">
            <input v-model="form.secret" type="checkbox" />
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          </label>
          <span class="env-secret-hint">开启后列表默认掩码显示（点「显示」可临时查看）</span>
        </div>
        <div class="cfg-btn-row env-form-actions">
          <button class="cfg-btn primary" :disabled="saving" @click="save">
            {{ editing === NEW ? "添加" : "保存" }}
          </button>
          <button class="cfg-btn ghost" :disabled="saving" @click="cancelEdit">取消</button>
        </div>
      </div>

      <!-- 列表 -->
      <div class="env-list">
        <div v-for="v in filtered" :key="v.name" class="env-item" :class="{ editing: editing === v.name }">
          <div class="env-item-main">
            <div class="env-item-name">
              <code>{{ v.name }}</code>
              <span v-if="v.secret !== false" class="badge env-badge">密钥</span>
              <span v-if="grantedCount(v.name) > 0" class="badge env-badge granted">
                {{ grantedCount(v.name) }} 个插件已授权
              </span>
              <span v-if="v.description" class="env-item-desc-icon" :title="v.description">❓</span>
            </div>
          </div>
          <div class="env-item-value">
            <span class="env-value" :class="{ literal: v.secret === false }">{{ valueText(v) }}</span>
            <button
              v-if="v.secret !== false && v.value !== ''"
              class="btn-link"
              @click="toggleReveal(v.name)"
            >
              {{ revealed.has(v.name) ? "隐藏" : "显示" }}
            </button>
          </div>
          <div class="env-item-actions">
            <button class="btn-sm" @click="startEdit(v)">编辑</button>
            <button class="btn-sm btn-warn" @click="remove(v)">删除</button>
          </div>
        </div>
        <div v-if="items.length === 0" class="env-empty">
          还没有环境变量。点「新增变量」添加，例如把 OpenAI / Anthropic 的 API Key 集中放在这里。
        </div>
        <div v-else-if="filtered.length === 0" class="env-empty">没有匹配「{{ keyword }}」的变量。</div>
      </div>
    </div>
  </section>
</template>