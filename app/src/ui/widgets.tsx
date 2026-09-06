import { useEffect, useMemo, useState } from 'react'
import { Select, Input as AntInput, Spin } from 'antd'

/**
 * 自定义表单组件：EntitySelect
 *
 * 设计要点：Schema 里只写 `{ entity: "customer" }`，不把客户名单写死进 Schema。
 * 数据由组件自己异步加载 —— Schema 保持纯粹、可版本化、不含业务数据。
 *
 * 这解决了一个真实问题：如果每次 Schema 都要塞 500 个客户选项，
 * 那这份 Schema 既不能提交进 Git，也会把模型的上下文撑爆。
 */
export function EntitySelect(props: any) {
  const { entity, ...rest } = props
  const [options, setOptions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!entity) return
    let alive = true
    setLoading(true)
    fetch(`/api/entities/${entity}`)
      .then((r) => r.json())
      .then((rows) => {
        if (!alive) return
        setOptions(
          (Array.isArray(rows) ? rows : []).map((r: any) =>
            typeof r === 'string' ? { value: r, label: r } : r
          )
        )
      })
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [entity])

  const merged = useMemo(() => {
    // 确认卡注入的歧义候选优先；再补上全量列表
    const injected = Array.isArray(rest.options) ? rest.options : []
    const byValue = new Map<string, any>()
    for (const o of [...injected, ...options]) {
      const v = o?.value
      if (v == null) continue
      if (!byValue.has(v)) byValue.set(v, o)
    }
    if (rest.value && !byValue.has(rest.value)) {
      byValue.set(rest.value, { value: rest.value, label: rest.value })
    }
    // 有候选时：候选排前面，方便点选
    const list = [...byValue.values()]
    if (injected.length) {
      const injIds = new Set(injected.map((o: any) => o.value))
      return [
        ...list.filter((o) => injIds.has(o.value)),
        ...list.filter((o) => !injIds.has(o.value)),
      ]
    }
    return list
  }, [options, rest.value, rest.options])

  // 不要把 options 再传给 Select（已用 merged）
  const { options: _ignore, ...selectProps } = rest

  return (
    <Select
      {...selectProps}
      loading={loading}
      showSearch
      optionFilterProp="label"
      filterOption={(input: string, option: any) =>
        String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
      }
      options={merged}
      notFoundContent={loading ? <Spin size="small" /> : '无匹配项'}
      style={{ width: '100%', ...(rest.style ?? {}) }}
    />
  )
}

/** Schema 里写 CustomerSelect / ProductSelect —— 与 EntitySelect 同一套异步下拉 */
export function CustomerSelect(props: any) {
  return <EntitySelect {...props} entity="customer" />
}

export function ProductSelect(props: any) {
  return <EntitySelect {...props} entity="product" />
}

export const TextArea = (props: any) => (
  <AntInput.TextArea {...props} rows={props.rows ?? 3} />
)

export { AntInput }
