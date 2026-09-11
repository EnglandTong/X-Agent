/**
 * 能力注册表 —— **只登记，不含实现**。
 *
 * 为什么刻意不含实现：一旦这里开始 import 具体动词，core 就再也搬不走了。
 * 插件靠 manifest 声明自己，core 只负责记住「有这个能力」。
 * 真正的实现由宿主（现在是 `server/verbs/`）在启动时注册进来。
 *
 * ⚠️ 铁律（T5）：本文件不得 import `server/`。
 */

export type CapabilityRisk = 'read' | 'write'

export interface CapabilityRef {
  /** 能力名，即动词名（order.create / inventory.query …） */
  name: string
  risk: CapabilityRisk
  /** 人类可读标题（来自 manifest 的 title） */
  title?: string
  /** manifest 的位置或标识，便于追溯 */
  source?: string
}

const capabilities = new Map<string, CapabilityRef>()

/** 登记一个能力（幂等：同 name 后登记者覆盖） */
export function register(ref: CapabilityRef): void {
  capabilities.set(ref.name, ref)
}

/** 批量登记 */
export function registerAll(refs: CapabilityRef[]): void {
  for (const r of refs) register(r)
}

export function getCapability(name: string): CapabilityRef | undefined {
  return capabilities.get(name)
}

export function listCapabilities(): CapabilityRef[] {
  return [...capabilities.values()]
}

export function clearCapabilities(): void {
  capabilities.clear()
}
