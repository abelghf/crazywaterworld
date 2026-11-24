import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Badge } from "../../badge";
import { Button } from "../../button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table";
import {
  type GuildRank,
  type Mail,
  parseSeasonPreview,
  type Ranking,
  type Section,
} from "../contracts/season-preview";
import { createAccountRequest } from "../lib/api";
import { getConsoleStore } from "../lib/console-store";
import { formatGameTime } from "../lib/time";

const labels = {
  merit: "最强个人 · 功勋榜",
  tech: "科技霸主 · 科技榜",
  mail: "邮件物品",
} as const;
const sections: Section[] = ["merit", "tech", "mail"];
const numberText = (n: string | null) =>
  n === null ? "未返回" : BigInt(n).toLocaleString("zh-CN");
const timeText = (t: number) => formatGameTime(t * 1000);

function BoardView({ board }: { board: Ranking }) {
  const label = board.kind === "merit" ? "功勋积分" : "科技积分";
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="dim">前 50 名 · 已返回 {board.rows.length} 人</span>
      </div>
      {(board.midEndTime || board.endTime) && (
        <p className="dim mb-3 text-sm">
          {[
            board.midEndTime && `中期结算 ${timeText(board.midEndTime)}`,
            board.endTime && `赛季结束 ${timeText(board.endTime)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {board.rows.length ? (
        <Table aria-label={labels[board.kind]}>
          <TableHeader>
            <TableRow>
              <TableHead>名次</TableHead>
              <TableHead>玩家</TableHead>
              <TableHead className="text-right">{label}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.rows.map((row) => (
              <TableRow key={row.rank}>
                <TableCell className="tabular-nums">{row.rank}</TableCell>
                <TableCell>
                  {row.name}{" "}
                  {row.playerId && row.playerId === board.mine?.playerId && (
                    <Badge variant="outline">我</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {numberText(row.score)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="dim">当前赛季榜单暂无玩家记录</p>
      )}
    </>
  );
}

function MailView({ mail }: { mail: Mail }) {
  const [all, setAll] = useState(false);
  const items = mail.items.filter((item) => all || item.pending !== "0");
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          包含已领取附件
        </label>
        <span className="dim">
          已读取 {mail.scanned} 封系统邮件 · {mail.reportsScanned} 条战报
        </span>
      </div>
      {items.length ? (
        <Table aria-label="邮件附件汇总">
          <TableHeader>
            <TableRow>
              <TableHead>物品与来源</TableHead>
              <TableHead className="text-right">未领取</TableHead>
              {all && <TableHead className="text-right">已领取</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.key}>
                <TableCell className="whitespace-normal">
                  <details>
                    <summary>{item.name}</summary>
                    <ul className="mt-2 grid gap-1 text-sm text-muted-foreground">
                      {item.sources
                        .filter((s) => all || !s.claimed)
                        .map((s) => (
                          <li key={`${s.kind}:${s.id}`}>
                            {s.kind === "report" ? "战报" : "系统"} ·{" "}
                            {s.subject} · {numberText(s.count)} ·{" "}
                            {s.claimed ? "已领" : "未领"}{" "}
                            {s.sendTime && timeText(s.sendTime)}
                          </li>
                        ))}
                    </ul>
                  </details>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {numberText(item.pending)}
                </TableCell>
                {all && (
                  <TableCell className="text-right tabular-nums">
                    {numberText(item.claimed)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="dim">
          {all ? "邮箱中没有留存的附件" : "当前没有未领取的邮件物品"}
        </p>
      )}
    </>
  );
}

type Snapshot = {
  merit?: Ranking;
  tech?: Ranking;
  guild?: GuildRank;
  mail?: Mail;
};
const paths = {
  merit: "/api/season/rank?kind=merit",
  tech: "/api/season/rank?kind=tech",
  guild: "/api/season/guild",
  mail: "/api/season/mail",
};

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

function MySeason({
  data,
  errors,
}: {
  data: Snapshot;
  errors: Partial<Record<keyof Snapshot, string>>;
}) {
  const unavailable = (key: keyof Snapshot) =>
    errors[key] ? "读取失败" : "读取中…";
  const guild = data.guild,
    merit = data.mail?.merit;
  return (
    <section
      aria-label="我的赛季"
      className="col-span-full rounded-lg border bg-muted/30 px-4 py-3 md:col-span-1 md:col-start-2 md:row-span-2 md:row-start-1"
    >
      <h3 className="mb-3 font-semibold">我的赛季</h3>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
        {(["merit", "tech"] as const).map((key) => {
          const board = data[key],
            row = board?.mine;
          return (
            <Stat
              key={key}
              label={key === "merit" ? "功勋排名" : "科技排名"}
              value={
                row
                  ? `第 ${row.rank} 名`
                  : board
                    ? "暂无名次"
                    : unavailable(key)
              }
              detail={
                row?.score != null
                  ? `${numberText(row.score)} 积分`
                  : errors[key]
              }
            />
          );
        })}
        <Stat
          label="联盟排名"
          value={
            guild?.rank
              ? `第 ${guild.rank} 名`
              : guild?.state === "notJoined"
                ? "未加入联盟"
                : guild
                  ? "暂无名次"
                  : unavailable("guild")
          }
          detail={
            guild?.score != null
              ? `${numberText(guild.score)} 积分`
              : errors.guild
          }
        />
        <Stat
          label="邮件功勋"
          value={
            merit ? `未领 ${numberText(merit.pending)}` : unavailable("mail")
          }
          detail={merit ? `已领 ${numberText(merit.claimed)}` : errors.mail}
        />
      </dl>
    </section>
  );
}

function Preview({ account }: { account: string }) {
  const [section, setSection] = useState<Section>("merit");
  const [batch, setBatch] = useState<{ first: Section }>({ first: "merit" });
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [errors, setErrors] = useState<Partial<Record<keyof Snapshot, string>>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const request = createAccountRequest(account);
    async function read() {
      const keys = new Set<keyof Snapshot>([
        batch.first,
        "merit",
        "tech",
        "guild",
        "mail",
      ]);
      for (const key of keys) {
        if (signal.aborted) return;
        try {
          const value = parseSeasonPreview(
            await request(paths[key], { signal }),
            key,
          );
          if (!signal.aborted)
            setSnapshot((prev) => ({ ...prev, [value.kind]: value }));
        } catch (e) {
          if (!signal.aborted)
            setErrors((prev) => ({
              ...prev,
              [key]: e instanceof Error ? e.message : "读取失败",
            }));
        }
      }
      if (!signal.aborted) setLoading(false);
    }
    void read();
    return () => controller.abort();
  }, [account, batch]);
  function refresh() {
    setLoading(true);
    setSnapshot({});
    setErrors({});
    setBatch({ first: section });
  }
  const data = snapshot[section],
    error = errors[section];
  const season =
    data?.season ?? Object.values(snapshot).find((v) => v.season)?.season;
  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto] gap-3 md:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)_auto]">
        <div>
          <CardTitle className="flex items-center gap-2">
            <h2>赛季预览</h2>
            {season && <Badge variant="secondary">S{season} 赛季</Badge>}
          </CardTitle>
          <CardDescription className="mt-2">世界 · 赛季目标</CardDescription>
        </div>
        <Button
          className="col-start-2 row-start-1 md:col-start-3"
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={loading}
        >
          刷新
        </Button>
        <MySeason data={snapshot} errors={errors} />
        <fieldset
          aria-label="赛季预览内容"
          className="col-span-full flex flex-wrap gap-2 md:col-span-1 md:col-start-1 md:row-start-2"
        >
          {sections.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={section === key ? "default" : "outline"}
              aria-pressed={section === key}
              onClick={() => setSection(key)}
            >
              {labels[key]}
            </Button>
          ))}
        </fieldset>
      </CardHeader>
      <CardContent>
        {!data && !error && <p role="status">正在读取{labels[section]}…</p>}
        {error && <p role="alert">{error}</p>}
        {data?.season === null && (
          <p className="dim">当前世界的赛季编号未同步</p>
        )}
        {data &&
          (data.kind === "mail" ? (
            <MailView mail={data} />
          ) : (
            <BoardView board={data} />
          ))}
      </CardContent>
    </Card>
  );
}

function SeasonPage() {
  const store = getConsoleStore();
  const active = useStore(store, (s) => s.view.page === "season-preview");
  const account = useStore(store, (s) => s.currentAccountId);
  const connected = useStore(store, (s) => {
    const id = s.currentAccountId;
    const status = id ? s.accountsById[id]?.status : undefined;
    return !!(
      id &&
      status?.connected &&
      !status.paused &&
      !s.disconnected.has(id)
    );
  });
  if (!active) return null;
  if (!account || !connected)
    return (
      <Card>
        <CardHeader>
          <CardTitle>赛季预览</CardTitle>
          <CardDescription>请先连接当前账号</CardDescription>
        </CardHeader>
      </Card>
    );
  return <Preview key={account} account={account} />;
}
export function mountSeasonPreview(host: HTMLElement) {
  createRoot(host).render(<SeasonPage />);
}
