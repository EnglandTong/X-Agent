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
    // 保证当前值即便不在列表里也能显示（例如历史数据）
    if (rest.value && !options.some((o) => o.value === rest.value)) {
      return [{ value: rest.value, label: rest.value }, ...options]
    }
    return options
  }, [options, rest.value])

  return (
    <Select
      {...rest}
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

export const TextArea = (props: any) => (
  <AntInput.TextArea {...props} rows={props.rows ?? 3} />
)

export { AntInput }
