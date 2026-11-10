import { useEffect, useState } from "react"
import type { Task } from "@spec/contract"
import { failureName, patternName } from "../../lib/labels"
import { time } from "../../lib/format"
import { Badge, Thumb, copyText } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { Modal } from "../../ui/overlays"
import { IconButton, cx } from "../../ui/controls"

export const TaskViewer = ({ tasks, index, onClose }: { tasks: Task[]; index: number | null; onClose: () => void }) => {
  const [i, setI] = useState(index ?? 0)
  const [out, setOut] = useState(0)
  const [play, setPlay] = useState(false)
  useEffect(() => {
    if (index != null) setI(index)
  }, [index])
  useEffect(() => {
    setOut(0)
    setPlay(false)
  }, [i])
  useEffect(() => {
    if (index == null) return
    const f = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((v) => Math.min(tasks.length - 1, v + 1))
      if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1))
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [index, tasks.length])
  const t = tasks[i]
  const media = t ? [...t.outputs] : []
  const m = media[out] ?? null
  const isVideo = m?.kind === "video"
  return (
    <div className="viewer-modal">
      <Modal bare open={index != null && !!t} onClose={onClose} width={1120}>
        {t && (
          <div className="viewer">
            <div className="stage">
              <span className="counter">
                {i + 1} / {tasks.length}
              </span>
              <div className="main-img">
                {m ? (
                  isVideo && play ? (
                    <video src={m.url} poster={m.poster ?? undefined} controls autoPlay />
                  ) : (
                    <button key={m.thumb} className="stage-img" onClick={() => isVideo && setPlay(true)}>
                      <img src={isVideo ? m.poster ?? m.thumb : m.thumb.replace(/w=\d+/, "w=1200")} alt="" />
                      {isVideo && (
                        <span style={{ position: "absolute", width: 56, height: 56, borderRadius: "50%", background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", color: "#fff" }}>
                          <Icon name="play" style={{ fill: "#fff", stroke: "none" }} />
                        </span>
                      )}
                    </button>
                  )
                ) : (
                  <div className="stack" style={{ alignItems: "center", gap: 8, color: "#a1a1aa" }}>
                    <Icon name="alert" size="lg" />
                    <span>{t.failed ? "生成失败，没有输出" : "没有输出"}</span>
                  </div>
                )}
              </div>
              {media.length > 1 && (
                <div className="strip">
                  {media.map((x, k) => (
                    <button key={k} onClick={() => setOut(k)} className={cx("thumb", k === out && "on")} style={{ width: 48, aspectRatio: "3/4", borderRadius: 6 }}>
                      <img src={x.kind === "video" ? x.poster ?? x.thumb : x.thumb} className="ready" alt="" />
                    </button>
                  ))}
                </div>
              )}
              {i > 0 && (
                <button className="nav-btn l" aria-label="上一个" onClick={() => setI(i - 1)}>
                  <Icon name="chevLeft" />
                </button>
              )}
              {i < tasks.length - 1 && (
                <button className="nav-btn r" aria-label="下一个" onClick={() => setI(i + 1)}>
                  <Icon name="chevRight" />
                </button>
              )}
            </div>
            <div className="info">
              <div className="sec" style={{ paddingRight: 52 }}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {t.downloaded ? <Badge tone="up" icon="download">已下载</Badge> : t.failed ? <Badge tone="down">失败</Badge> : <Badge tone="outline">未下载</Badge>}
                  {t.intent && <Badge>{t.intent}</Badge>}
                  {t.pattern !== "none" && t.pattern !== "new" && <Badge tone={t.pattern === "batch" ? "accent" : t.pattern === "retry" || t.pattern === "tweak" ? "warn" : undefined}>{patternName[t.pattern]}</Badge>}
                </div>
                <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                  {time(t.createdAt)} · {t.user?.name ?? "未知成员"}
                </div>
              </div>
              <div className="sec">
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="label" style={{ margin: 0 }}>提示词</span>
                  <span className="spacer" />
                  <IconButton size="xs" icon="copy" label="复制提示词" onClick={() => copyText(t.prompt, "提示词已复制")} />
                </div>
                <div className="prompt">{t.prompt || <span className="faint">无</span>}</div>
              </div>
              {t.inputs.length > 0 && (
                <div className="sec">
                  <span className="label">输入 · {t.inputs.length}</span>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {t.inputs.map((x, k) => (
                      <Thumb key={k} media={x} w={64} ratio={4 / 3} onClick={() => window.open(x.url, "_blank", "noopener")} />
                    ))}
                  </div>
                </div>
              )}
              {t.failure && (
                <div className="sec">
                  <span className="label">失败 · {failureName[t.failure.category]}</span>
                  <div className="stack" style={{ gap: 6, fontSize: 12.5 }}>
                    <span>
                      <span className="faint">客户看到 </span>
                      {t.failure.userMessage ?? "—"}
                    </span>
                    <span>
                      <span className="faint">真实原因 </span>
                      <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.failure.providerMessage ?? "—"}</code>
                    </span>
                  </div>
                </div>
              )}
              <div className="sec">
                <dl className="kv">
                  <dt>模式</dt>
                  <dd>{t.mode}</dd>
                  <dt>模型</dt>
                  <dd>{t.model ?? "—"}</dd>
                  <dt>耗点</dt>
                  <dd className="num">{t.points}</dd>
                  {t.config.resolution && (
                    <>
                      <dt>规格</dt>
                      <dd>
                        {[t.config.resolution, t.config.ratio, t.config.videoDuration ? `${t.config.videoDuration}s` : null, t.config.audio ? "有声" : null].filter(Boolean).join(" · ")}
                      </dd>
                    </>
                  )}
                  {t.durationSeconds != null && (
                    <>
                      <dt>生成用时</dt>
                      <dd className="num">{Math.round(t.durationSeconds)} 秒</dd>
                    </>
                  )}
                  {t.downloadVia.length > 0 && (
                    <>
                      <dt>下载方式</dt>
                      <dd>{t.downloadVia.join("、")}</dd>
                    </>
                  )}
                  <dt>记录</dt>
                  <dd>
                    <code style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)" }}>{t.sourceId}</code>
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
