import { useCtx } from "../lib/ctx"
import { Empty } from "../ui/display"

export const PlaygroundPage = () => {
  const { route } = useCtx()
  return (
    <div className="page">
      <Empty icon="image" title="试验台" text={route.tpl ? "R4 阶段接入" : "从模板草稿进入"} />
    </div>
  )
}
