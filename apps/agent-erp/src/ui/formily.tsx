import { createSchemaField } from '@formily/react'
import {
  FormItem,
  Input,
  NumberPicker,
  Select,
  DatePicker,
  Space,
} from '@formily/antd-v5'
import { EntitySelect, CustomerSelect, ProductSelect, TextArea } from './widgets'

/**
 * Formily SchemaField —— 整个架构的地基。
 *
 * 这一行就是「一份 Schema，两个消费者」中「消费者 A」的全部实现：
 * 给一份 JSON Schema，Formily 渲染出完整可用的 antd 表单，
 * 包含校验、布局、数据绑定，一行表单代码都不用手写。
 *
 * 消费者 B（给模型的工具定义）在 server/compile.ts，读的是同一份 JSON。
 */
export const SchemaField = createSchemaField({
  components: {
    FormItem,
    Input,
    TextArea,
    NumberPicker,
    Select,
    DatePicker,
    Space,
    EntitySelect,
    CustomerSelect,
    ProductSelect,
  },
})
