import { Package, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../dialog";
import { Input } from "../../input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table";
import {
  parseShopGameRefresh,
  parseShopPurchase,
  parseShops,
  SHOP_CHOICES,
  type ShopAmount,
  type ShopGameRefresh,
  type ShopGameRefreshRequest,
  type ShopGameRefreshResult,
  type ShopId,
  type ShopProduct,
  type ShopPurchaseRequest,
  type ShopPurchaseResult,
  type ShopSummary,
  type ShopView,
} from "../contracts/shops";
import { createAccountRequest } from "../lib/api";
import { type ConsoleState, getConsoleStore } from "../lib/console-store";
import { formatGameTime } from "../lib/time";
import styles from "./shops.module.css";

// Shop writes can outlive a page or account switch. Share their account lock
// outside the mounted view, and wait for it before requesting another quote.
const pending = new Map<
  string,
  Promise<ShopPurchaseResult | ShopGameRefreshResult>
>();
const receipts = new Map<string, ShopPurchaseResult>();
const refreshReceipts = new Map<string, ShopGameRefreshResult>();
type ShopChoice = Pick<ShopSummary, "id" | "title">;

function connectionHint(state: ConsoleState) {
  const account = state.currentAccountId;
  if (!account || !state.accountsById[account]) return "请先选择账号";
  const status = state.accountsById[account].status;
  if (status?.paused) return "账号已暂停，请先恢复托管后查看商店";
  if (status?.reconnecting) return "账号正在重连，请稍后查看商店";
  if (
    status?.loginBlocked ||
    status?.connected !== true ||
    state.disconnected.has(account)
  )
    return "请先连接当前账号，再查看商店";
  return "";
}

function canInteract(account: string) {
  const state = getConsoleStore().getState();
  return (
    !document.hidden &&
    state.view.page === "shops" &&
    state.currentAccountId === account &&
    !connectionHint(state)
  );
}

function amountText(item: Pick<ShopAmount, "id" | "name" | "num">) {
  return `${item.num.toLocaleString("zh-CN")} ${item.name || item.id || "资源"}`;
}

function maximum(product: ShopProduct, ad: boolean) {
  return Math.min(
    product.maxQuantity,
    product.remaining ?? Number.MAX_SAFE_INTEGER,
    ad ? 1 : Number.MAX_SAFE_INTEGER,
  );
}

function validQuantity(product: ShopProduct, quantity: number, ad: boolean) {
  return (
    Number.isSafeInteger(quantity) &&
    quantity >= 1 &&
    quantity <= maximum(product, ad) &&
    Number.isSafeInteger(product.price.num * quantity) &&
    Number.isSafeInteger(product.asset.num * quantity)
  );
}

function submitPurchase(account: string, request: ShopPurchaseRequest) {
  const job: Promise<ShopPurchaseResult> = Promise.resolve()
    .then(async (): Promise<ShopPurchaseResult> => {
      if (!canInteract(account))
        return {
          status: "cancelled",
          message: "账号或页面状态已变化，购买尚未发送，请重新读取商品",
          shopId: request.shop,
          productId: request.id,
          quantity: request.quantity,
          rewards: [],
          costs: [],
        };
      try {
        const data = await createAccountRequest(account)(
          "/api/shops/purchase",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return parseShopPurchase(data, request);
      } catch (failure) {
        return {
          status: "unknown",
          message:
            failure instanceof Error ? failure.message : "购买请求结果待确认",
          shopId: request.shop,
          productId: request.id,
          quantity: request.quantity,
          rewards: [],
          costs: [],
        };
      }
    })
    .then((result) => {
      if (getConsoleStore().getState().accountsById[account])
        receipts.set(account, result);
      else receipts.delete(account);
      if (pending.get(account) === job) pending.delete(account);
      return result;
    });
  pending.set(account, job);
  return job;
}

function submitGameRefresh(account: string, request: ShopGameRefreshRequest) {
  const job: Promise<ShopGameRefreshResult> = Promise.resolve()
    .then(async (): Promise<ShopGameRefreshResult> => {
      if (!canInteract(account))
        return {
          action: "game-refresh",
          status: "cancelled",
          message:
            "账号或页面状态已变化，更新游戏商店尚未发送，请重新获取商店商品",
          shopId: "discount",
          costs: [],
        };
      try {
        const data = await createAccountRequest(account)(
          "/api/shops/game-refresh",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return parseShopGameRefresh(data);
      } catch (failure) {
        return {
          action: "game-refresh",
          status: "unknown",
          message:
            failure instanceof Error
              ? failure.message
              : "更新游戏商店请求结果待确认",
          shopId: "discount",
          costs: [],
        };
      }
    })
    .then((result) => {
      if (getConsoleStore().getState().accountsById[account])
        refreshReceipts.set(account, result);
      else refreshReceipts.delete(account);
      if (pending.get(account) === job) pending.delete(account);
      return result;
    });
  pending.set(account, job);
  return job;
}

function ProductIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.icon} aria-hidden="true">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          width={44}
          height={44}
          onError={() => setFailed(true)}
        />
      ) : (
        <Package className="text-muted-foreground" />
      )}
    </span>
  );
}

function ProductRow({
  product,
  ad,
  busy,
  choose,
}: {
  product: ShopProduct;
  ad: boolean;
  busy: boolean;
  choose: (product: ShopProduct, quantity: number) => void;
}) {
  const [quantity, setQuantity] = useState("1");
  const value = Number(quantity);
  const valid = validQuantity(product, value, ad);
  const available = product.canBuy && Boolean(product.token);
  const name = product.name || product.asset.name || "未命名商品";
  const errorId = `shop-quantity-${product.id}-error`;
  return (
    <TableRow data-product-id={product.id} aria-label={name}>
      <TableCell>
        <div className={styles.productHeading}>
          <ProductIcon src={product.asset.icon} />
          <div>
            <strong className="font-medium">{name}</strong>
            <p className="text-xs text-muted-foreground">
              每份 {amountText(product.asset)}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell data-label="单份价格">
        <div>
          <span className="tabular-nums">
            {product.price.num === 0 ? "免费" : amountText(product.price)}
          </span>
          {product.discount > 0 && product.discount < 100 && (
            <Badge className="ml-1" variant="secondary">
              {product.discount / 10} 折
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell data-label="剩余限购">
        <div>
          <span className="tabular-nums">
            {product.remaining === null ? "不限购" : `${product.remaining} 份`}
          </span>
          {product.buyTimes > 0 && (
            <p className="text-xs text-muted-foreground">
              已{ad ? "领取" : "购买"} {product.buyTimes} 份
            </p>
          )}
          {product.blockedReason ? (
            <p className="text-xs text-muted-foreground">
              {product.blockedReason}
            </p>
          ) : (
            (product.vipLevel > 0 || product.dan > 0) && (
              <p className="text-xs text-muted-foreground">
                {product.vipLevel > 0 && `需 VIP ${product.vipLevel}`}
                {product.dan > 0 && ` 需段位 ${product.dan}`}
              </p>
            )
          )}
        </div>
      </TableCell>
      <TableCell data-label="操作">
        <div>
          <div className={styles.purchaseRow}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={maximum(product, ad)}
              step={1}
              value={quantity}
              disabled={busy || !available}
              readOnly={ad}
              aria-label={`${name}购买份数`}
              aria-invalid={available && !valid}
              aria-describedby={available && !valid ? errorId : undefined}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !available || !valid}
              aria-label={`${ad ? "领取" : "购买"}${name}`}
              aria-haspopup="dialog"
              onClick={() => choose(product, value)}
            >
              {ad ? "领取" : "购买"}
            </Button>
          </div>
          {available && !valid && (
            <p id={errorId} className="mt-1 text-xs text-destructive">
              请输入 1 至 {maximum(product, ad)} 的整数份数
            </p>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function PurchaseDialog({
  account,
  product,
  quantity,
  ad,
  confirm,
  dismiss,
}: {
  account: string;
  product: ShopProduct;
  quantity: number;
  ad: boolean;
  confirm: () => void;
  dismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = getConsoleStore().getState().accountsById[account];
  const accountName =
    selected?.title ||
    selected?.label ||
    selected?.lastSeen?.nickname ||
    account;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shop-purchase-title"
      aria-describedby="shop-purchase-description"
      onClose={dismiss}
    >
      <DialogHeader>
        <DialogTitle id="shop-purchase-title">
          {ad ? "确认领取" : "确认购买"}
        </DialogTitle>
        <DialogDescription id="shop-purchase-description">
          请核对当前账号、购买份数与总价。
        </DialogDescription>
      </DialogHeader>
      <dl className={styles.facts}>
        <dt>账号</dt>
        <dd>{accountName}</dd>
        <dt>商品</dt>
        <dd>{product.name || product.asset.name}</dd>
        <dt>购买份数</dt>
        <dd>{quantity} 份</dd>
        <dt>预计获得</dt>
        <dd>
          {amountText({ ...product.asset, num: product.asset.num * quantity })}
        </dd>
        <dt>总价</dt>
        <dd>
          {product.price.num === 0
            ? "免费"
            : amountText({
                ...product.price,
                num: product.price.num * quantity,
              })}
        </dd>
      </dl>
      {ad && (
        <p className="text-sm text-muted-foreground">
          广告商品每次领取一份，按账号的广告权益处理，可能需要等待。
        </p>
      )}
      <DialogFooter>
        <Button type="button" onClick={confirm}>
          {ad ? "确认领取" : "确认购买"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => dialog.current?.close()}
        >
          取消
        </Button>
      </DialogFooter>
    </dialog>
  );
}

function GameRefreshDialog({
  account,
  quote,
  confirm,
  dismiss,
}: {
  account: string;
  quote: ShopGameRefresh;
  confirm: () => void;
  dismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = getConsoleStore().getState().accountsById[account];
  const accountName =
    selected?.title ||
    selected?.label ||
    selected?.lastSeen?.nickname ||
    account;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shop-game-refresh-title"
      aria-describedby="shop-game-refresh-description"
      onClose={dismiss}
    >
      <DialogHeader>
        <DialogTitle id="shop-game-refresh-title">更新游戏商店</DialogTitle>
        <DialogDescription id="shop-game-refresh-description">
          此操作会按下列费用和次数更新游戏内的折扣商店，更换可购买商品。请核对后确认。
        </DialogDescription>
      </DialogHeader>
      <dl className={styles.facts}>
        <dt>账号</dt>
        <dd>{accountName}</dd>
        <dt>商店</dt>
        <dd>折扣商店</dd>
        <dt>本次费用</dt>
        <dd>{quote.price.num === 0 ? "免费" : amountText(quote.price)}</dd>
        <dt>已更新次数</dt>
        <dd>{quote.refreshCount} 次</dd>
        <dt>更新上限</dt>
        <dd>{quote.limit} 次</dd>
        <dt>剩余次数</dt>
        <dd>{quote.remaining} 次（本次将使用 1 次）</dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        仅查看当前商品，请使用“重新获取商店商品”，只读获取不消耗资源或更新次数。
      </p>
      <DialogFooter>
        <Button type="button" onClick={confirm}>
          确认更新游戏商店
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => dialog.current?.close()}
        >
          取消
        </Button>
      </DialogFooter>
    </dialog>
  );
}

function PurchaseResult({ result }: { result: ShopPurchaseResult }) {
  const labels = {
    completed: "已完成",
    unknown: "结果待核对",
    rejected: "未购买",
    cancelled: "已取消",
  };
  const title = SHOP_CHOICES.find((shop) => shop.id === result.shopId)?.title;
  return (
    <div
      className={styles.result}
      role="status"
      data-purchase-status={result.status}
    >
      <p className="font-medium">
        {title} · {labels[result.status]}
      </p>
      {result.message && <p>{result.message}</p>}
      {result.costs.length > 0 && (
        <p>
          {result.status === "completed" ? "消耗" : "待核对费用"}：
          {result.costs.map(amountText).join("、")}
        </p>
      )}
      {result.rewards.length > 0 && (
        <p>
          {result.status === "completed" ? "获得" : "待核对奖励"}：
          {result.rewards.map(amountText).join("、")}
        </p>
      )}
      {result.status === "unknown" && (
        <p>
          请核对商品购买次数、余额与到账情况，勿重复购买。可点击“重新获取商店商品”只读核对。
        </p>
      )}
    </div>
  );
}

function GameRefreshResult({ result }: { result: ShopGameRefreshResult }) {
  const labels = {
    completed: "已完成",
    unknown: "结果待确认",
    rejected: "未更新",
    cancelled: "已取消",
  };
  return (
    <div
      className={styles.result}
      role="status"
      data-game-refresh-status={result.status}
    >
      <p className="font-medium">
        折扣商店 · 更新游戏商店 · {labels[result.status]}
      </p>
      {result.message && <p>{result.message}</p>}
      {result.costs.length > 0 && (
        <p>
          {result.status === "completed" ? "消耗" : "待核对费用"}：
          {result.costs.map(amountText).join("、")}
        </p>
      )}
      {result.status === "unknown" && (
        <p>
          请核对更新次数、商品和余额，勿重复点击“更新游戏商店”。可点击“重新获取商店商品”只读核对。
        </p>
      )}
    </div>
  );
}

function ShopPanel({
  account,
  shop,
  onCatalog,
}: {
  account: string;
  shop: ShopId;
  onCatalog: (catalog: ShopSummary[]) => void;
}) {
  const [view, setView] = useState<ShopView | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(receipts.get(account));
  const [refreshResult, setRefreshResult] = useState(
    refreshReceipts.get(account),
  );
  const [refreshConfirmation, setRefreshConfirmation] =
    useState<ShopGameRefresh | null>(null);
  const [confirmation, setConfirmation] = useState<{
    product: ShopProduct;
    quantity: number;
  } | null>(null);
  const alive = useRef(true);
  const ad = shop === "ad";
  const gameRefresh = shop === "discount" ? view?.gameRefresh : null;
  const canUpdateGameShop = Boolean(
    gameRefresh?.canRefresh && gameRefresh.token && gameRefresh.remaining > 0,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual reads and settled shop writes require a new server quote.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      setBusy(true);
      setView(null);
      setError("");
      try {
        await pending.get(account);
        signal.throwIfAborted();
        if (!canInteract(account)) return;
        setResult(receipts.get(account));
        setRefreshResult(refreshReceipts.get(account));
        const data = await createAccountRequest(account)(
          `/api/shops?${new URLSearchParams({ shop })}`,
          { method: "GET", signal },
        );
        if (!signal.aborted && canInteract(account)) {
          const parsed = parseShops(data, shop);
          setView(parsed);
          onCatalog(parsed.catalog);
        }
      } catch (failure) {
        if (!signal.aborted)
          setError(failure instanceof Error ? failure.message : "读取商店失败");
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [account, shop, revision, onCatalog]);

  function reloadProducts() {
    setConfirmation(null);
    setRefreshConfirmation(null);
    setBusy(true);
    setView(null);
    setError("");
    setRevision((value) => value + 1);
  }

  function choose(product: ShopProduct, quantity: number) {
    if (
      busy ||
      pending.has(account) ||
      !canInteract(account) ||
      !product.canBuy ||
      !product.token ||
      !validQuantity(product, quantity, ad)
    )
      return;
    setRefreshConfirmation(null);
    setConfirmation({ product, quantity });
  }

  async function purchase() {
    if (!confirmation) return;
    const { product, quantity } = confirmation;
    if (
      busy ||
      pending.has(account) ||
      !canInteract(account) ||
      !view?.products.some(
        (entry) => entry.id === product.id && entry.token === product.token,
      ) ||
      !product.canBuy ||
      !product.token ||
      !validQuantity(product, quantity, ad)
    )
      return;
    setConfirmation(null);
    setBusy(true);
    setError("");
    setResult(undefined);
    setProgress(ad ? "正在领取，请等待结果…" : "正在购买，请等待结果…");
    const outcome = await submitPurchase(account, {
      shop,
      id: product.id,
      quantity,
      token: product.token,
      confirm: true,
      paid: product.price.id === "RUBY" && product.price.num > 0,
    });
    if (!alive.current || !canInteract(account)) return;
    setResult(outcome);
    setProgress("");
    reloadProducts();
  }

  function chooseGameRefresh() {
    if (
      busy ||
      pending.has(account) ||
      !canInteract(account) ||
      !gameRefresh ||
      !canUpdateGameShop
    )
      return;
    setConfirmation(null);
    setRefreshConfirmation(gameRefresh);
  }

  async function updateGameShop() {
    if (
      busy ||
      pending.has(account) ||
      !canInteract(account) ||
      shop !== "discount" ||
      !refreshConfirmation ||
      !gameRefresh ||
      !canUpdateGameShop ||
      gameRefresh.token !== refreshConfirmation.token
    )
      return;
    const quote = refreshConfirmation;
    setRefreshConfirmation(null);
    setBusy(true);
    setError("");
    setProgress("正在更新游戏商店，请等待结果…");
    const outcome = await submitGameRefresh(account, {
      shop: "discount",
      token: quote.token,
      confirm: true,
      paid: quote.price.id === "RUBY" && quote.price.num > 0,
    });
    if (!alive.current || !canInteract(account)) return;
    setRefreshResult(outcome);
    setProgress("");
    reloadProducts();
  }

  const title =
    view?.shop.title || SHOP_CHOICES.find((entry) => entry.id === shop)?.title;
  return (
    <div className={styles.content} aria-busy={busy}>
      <div className={styles.toolbar}>
        <div>
          <h3 className="font-semibold">{title}</h3>
          {view && (
            <p className="mt-1 text-xs text-muted-foreground">
              列表获取于 {formatGameTime(view.updatedAt)}（北京时间）
              {view.nextRefreshTime > 0 && (
                <>
                  {" "}
                  · 游戏商店下次自动更新{" "}
                  {formatGameTime(view.nextRefreshTime * 1000)}
                </>
              )}
            </p>
          )}
        </div>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={reloadProducts}
          >
            <RefreshCw aria-hidden="true" />
            重新获取商店商品
          </Button>
          {shop === "discount" && (
            <Button
              type="button"
              size="sm"
              disabled={busy || !canUpdateGameShop}
              aria-haspopup="dialog"
              aria-describedby="shop-game-refresh-info"
              onClick={chooseGameRefresh}
            >
              更新游戏商店
            </Button>
          )}
        </div>
      </div>
      {shop === "discount" && (
        <section
          id="shop-game-refresh-info"
          className={styles.gameRefresh}
          aria-label="游戏商店更新信息"
        >
          <p className="text-sm text-muted-foreground">
            更新将更换当前商品，并使用一次更新次数。
          </p>
          {gameRefresh && (
            <p className="text-sm">
              本次费用：
              {gameRefresh.price.num === 0
                ? "免费"
                : amountText(gameRefresh.price)}
              ；已更新 {gameRefresh.refreshCount} / {gameRefresh.limit} 次；剩余{" "}
              {gameRefresh.remaining} 次
            </p>
          )}
          {view && (gameRefresh?.blockedReason || !canUpdateGameShop) && (
            <p className="text-sm text-muted-foreground">
              {gameRefresh?.blockedReason ||
                (gameRefresh?.remaining === 0
                  ? "已无剩余更新次数"
                  : "当前无法更新游戏商店，请重新获取商店商品后查看最新状态")}
            </p>
          )}
        </section>
      )}
      {busy && (
        <p className={styles.notice} role="status">
          {progress ||
            (pending.has(account)
              ? "上一笔商店操作仍在处理，请等待结果…"
              : "正在读取商品与余额…")}
        </p>
      )}
      {result?.shopId === shop && <PurchaseResult result={result} />}
      {refreshResult && shop === "discount" && (
        <GameRefreshResult result={refreshResult} />
      )}
      {error && (
        <p className={`${styles.notice} text-destructive`} role="alert">
          {error}
        </p>
      )}
      {view?.hint && (
        <p className="text-sm text-muted-foreground">{view.hint}</p>
      )}
      {view && view.balances.length > 0 && (
        <fieldset className={styles.balances} aria-label="当前货币">
          {view.balances.map((balance) => (
            <Badge key={balance.id} variant="secondary">
              持有 {amountText(balance)}
            </Badge>
          ))}
        </fieldset>
      )}
      {view?.products.length === 0 && (
        <p className="text-muted-foreground">当前商店暂无商品</p>
      )}
      {view && view.products.length > 0 && (
        <div className="table-stack">
          <Table aria-label={`${title}商品`}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">商品</TableHead>
                <TableHead scope="col">单份价格</TableHead>
                <TableHead scope="col">剩余限购</TableHead>
                <TableHead scope="col">份数与操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.products.map((product) => (
                <ProductRow
                  key={`${product.id}:${product.token}`}
                  product={product}
                  ad={ad}
                  busy={busy}
                  choose={choose}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {refreshConfirmation && (
        <GameRefreshDialog
          account={account}
          quote={refreshConfirmation}
          confirm={() => void updateGameShop()}
          dismiss={() => setRefreshConfirmation(null)}
        />
      )}
      {confirmation && (
        <PurchaseDialog
          account={account}
          product={confirmation.product}
          quantity={confirmation.quantity}
          ad={ad}
          confirm={() => void purchase()}
          dismiss={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}

function ShopsPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "shops");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, connectionHint);
  const [visible, setVisible] = useState(!document.hidden);
  const [shop, setShop] = useState<ShopId>("vip");
  const [catalog, setCatalog] = useState<readonly ShopChoice[]>(SHOP_CHOICES);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  if (!active || !visible) return null;
  return (
    <Card data-account={account ?? ""}>
      <CardHeader>
        <CardTitle>
          <h2>商店</h2>
        </CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent className={styles.content}>
        <fieldset className="config-subtabs" aria-label="商店分类">
          {catalog.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={shop === entry.id}
              onClick={() => setShop(entry.id)}
            >
              {entry.title}
            </button>
          ))}
        </fieldset>
        {account && !hint && (
          <ShopPanel
            key={`${account}:${shop}`}
            account={account}
            shop={shop}
            onCatalog={setCatalog}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function mountShops(host: HTMLElement) {
  createRoot(host).render(<ShopsPage />);
}
