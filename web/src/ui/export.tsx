import type { ReactNode } from "react"
import { Button } from "./controls"
import type { IconName } from "./icons"
import { Menu } from "./overlays"

export interface ExportAction { key: string; label: ReactNode; hint?: ReactNode; icon?: IconName; run: () => void; disabled?: boolean; sep?: boolean }

export const ExportMenu = ({ items, label = "导出", size, variant }: { items: ExportAction[]; label?: string; size?: "sm" | "xs"; variant?: "ghost" | "secondary" }) => (
  <Menu
    width={260}
    items={items.map((i) => ({ key: i.key, label: i.label, hint: i.hint, icon: i.icon ?? "download", disabled: i.disabled, sep: i.sep, onSelect: i.run }))}
    trigger={({ toggle, ref, open }) => (
      <Button ref={ref as never} size={size} variant={variant} icon="download" iconRight="chevDown" onClick={toggle} active={open}>
        {label}
      </Button>
    )}
  />
)
