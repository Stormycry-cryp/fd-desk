import { useCtx } from "../lib/ctx"
import { navigate } from "../lib/route"
import { Button } from "../ui/controls"
import { Card } from "../ui/display"
import { EnterpriseView } from "./enterprise/EnterpriseView"

export const EnterprisePage = () => {
  const { route } = useCtx()
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div style={{ padding: "12px 0 16px" }}>
        <Button size="sm" variant="ghost" icon="chevLeft" onClick={() => (history.length > 1 ? history.back() : navigate({ page: "customers" }))}>
          返回
        </Button>
      </div>
      <Card flush>{route.ent ? <EnterpriseView id={route.ent} page /> : null}</Card>
    </div>
  )
}
