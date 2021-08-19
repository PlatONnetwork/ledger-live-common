// @flow
import { BigNumber } from "bignumber.js";
import union from "lodash/union";
import throttle from "lodash/throttle";
import flatMap from "lodash/flatMap";
import { log } from "@ledgerhq/logs";
import { mergeOps } from "../../bridge/jsHelpers";
import type { GetAccountShape } from "../../bridge/jsHelpers";
import {
  encodeTokenAccountId,
  decodeTokenAccountId,
  areAllOperationsLoaded,
  inferSubOperations,
  emptyHistoryCache,
} from "../../account";
import {
  findTokenByAddress,
  listTokensForCryptoCurrency,
} from "../../currencies";
import type { Operation, TokenAccount, Account } from "../../types";
import { apiForCurrency } from "../../api/Platon";
import type { Tx } from "../../api/Platon";
import { digestTokenAccounts, prepareTokenAccounts } from "./modules";

export const getAccountShape: GetAccountShape = async (
  infoInput,
  { blacklistedTokenIds }
) => {
  console.log('_-_-_-_=> getAccountShape');
  let { currency, address, initialAccount } = infoInput;
  const info = { ...infoInput };

  const api = apiForCurrency(currency);
  const initialStableOperations = initialAccount
    ? stableOperations(initialAccount)
    : [];

  // fetch transactions, incrementally if possible
  const mostRecentStableOperation = initialStableOperations[0];

  // when new tokens are added / blacklist changes, we need to sync again because we need to go through all operations again
  const syncHash =
    JSON.stringify(blacklistedTokenIds || []) +
    "_" +
    listTokensForCryptoCurrency(currency, { withDelisted: true }).length;
  const outdatedBlacklist = initialAccount?.syncHash !== syncHash;

  let pullFromBlockHash =
    initialAccount &&
    areAllOperationsLoaded(initialAccount) &&
    mostRecentStableOperation &&
    !outdatedBlacklist
      ? mostRecentStableOperation.blockHash
      : undefined;

  const txsP = fetchAllTransactions(api, address);
  const currentBlockP = api.getCurrentBlock();
  const balanceP = api.getAccountBalance(address);

  // const [txs, currentBlock] = await Promise.all([txsP, currentBlockP]);
  const [txs, blockHeight] = await Promise.all([txsP, currentBlockP]);

  // const blockHeight = currentBlock.height.toNumber();

  if (!pullFromBlockHash && txs.length === 0) {
    log("platon", "no ops on " + address);
    return {
      balance: BigNumber(0),
      subAccounts: [],
      blockHeight,
    };
  }

  const balance = await balanceP;

  // transform transactions into operations
  let newOps = flatMap(txs, txToOps(info));

  // extracting out the sub operations by token account
  const perTokenAccountIdOperations = {};
  newOps.forEach((op) => {
    const { subOperations } = op;
    if (subOperations?.length) {
      subOperations.forEach((sop) => {
        if (!perTokenAccountIdOperations[sop.accountId]) {
          perTokenAccountIdOperations[sop.accountId] = [];
        }
        perTokenAccountIdOperations[sop.accountId].push(sop);
      });
    }
  });

  const subAccountsExisting = {};
  initialAccount?.subAccounts?.forEach((a) => {
    // in case of coming from libcore, we need to converge to new ids
    const { token } = decodeTokenAccountId(a.id);
    if (!token) return;
    const id = encodeTokenAccountId(infoInput.id, token);
    subAccountsExisting[id] = a;
  });
  const subAccountsExistingIds = Object.keys(subAccountsExisting);
  const perTokenAccountChangedIds = Object.keys(perTokenAccountIdOperations);

  log(
    "platon",
    `${address} reconciliate ${txs.length} txs => ${newOps.length} new ops. ${perTokenAccountChangedIds.length} updates into ${subAccountsExistingIds.length} token accounts`
  );

  // reconciliate token accounts
  let tokenAccounts: TokenAccount[] = union(
    subAccountsExistingIds,
    perTokenAccountChangedIds
  )
    .map((id) => {
      const existing = subAccountsExisting[id];
      const newOps = perTokenAccountIdOperations[id];
      const { accountId, token } = decodeTokenAccountId(id);
      if (
        !token ||
        (blacklistedTokenIds && blacklistedTokenIds.includes(token.id))
      ) {
        return null;
      }
      if (existing && !newOps) return existing;
      const existingOps = existing?.operations || [];
      const operations = newOps ? mergeOps(existingOps, newOps) : existingOps;
      const lastOperation = operations[operations.length - 1];
      const creationDate =
        existing?.creationDate ||
        (lastOperation ? lastOperation.date : new Date());
      const pendingOperations = existing?.pendingOperations || [];
      const starred = existing?.starred || false;
      const swapHistory = existing?.swapHistory || [];
      return {
        type: "TokenAccount",
        id,
        token,
        parentId: accountId,
        balance: existing?.balance || BigNumber(0), // resolved in batched after this
        spendableBalance: existing?.balance || BigNumber(0), // resolved in batched after this
        creationDate,
        operationsCount: operations.length,
        operations,
        pendingOperations,
        starred,
        swapHistory,
        balanceHistoryCache: emptyHistoryCache, // calculated in the jsHelpers
      };
    })
    .filter(Boolean);

  tokenAccounts = await prepareTokenAccounts(currency, tokenAccounts, address);

  tokenAccounts = await loadERC20Balances(tokenAccounts, address, api);

  tokenAccounts = await digestTokenAccounts(currency, tokenAccounts, address);

  const subAccounts = reconciliateSubAccounts(tokenAccounts, initialAccount);

  // has sub accounts have changed, we need to relink the subOperations
  newOps = newOps.map((o) => ({
    ...o,
    subOperations: inferSubOperations(o.hash, subAccounts),
  }));

  const operations = mergeOps(initialStableOperations, newOps);

  const accountShape: $Shape<Account> = {
    operations,
    balance,
    subAccounts,
    spendableBalance: balance,
    blockHeight,
    lastSyncDate: new Date(),
    balanceHistory: undefined,
    syncHash,
  };

  return accountShape;
};

// in case of a SELF send, 2 ops are returned.
const txToOps = ({ currency, address, id }) => (tx: Tx): Operation[] => {
  const { from, to, txHash, blockNumber, actualTxCost } = tx;
  const addr = address;
  const sending = addr === from;
  const receiving = addr === to;
  const hash = txHash;
  const magnitude = BigNumber(10).pow(currency.units[0].magnitude)
  const value = BigNumber(tx.value).times(magnitude);
  const fee = BigNumber(actualTxCost).times(magnitude);
  const hasFailed = BigNumber(tx.txReceiptStatus || 0).eq(0);
  const blockHeight = blockNumber;
  const blockHash = tx.blockHash || txHash;
  const date = tx.timestamp ? new Date(tx.timestamp) : new Date();

  const ops = [];

  if (sending) {
    const type = value.eq(0) ? "FEES" : "OUT";
    ops.push({
      id: `${id}-${hash}-${type}`,
      hash,
      type,
      value: hasFailed ? BigNumber(0) : value.plus(fee),
      fee,
      blockHeight,
      blockHash,
      accountId: id,
      senders: [from],
      recipients: [to],
      date,
      extra: {},
      hasFailed,
    });
  }

  if (receiving) {
    ops.push({
      id: `${id}-${hash}-IN`,
      hash: hash,
      type: "IN",
      value,
      fee,
      blockHeight,
      blockHash,
      accountId: id,
      senders: [from],
      recipients: [to],
      date: new Date(date.getTime() + 1), // hack: make the IN appear after the OUT in history.
      extra: {},
    });
  }

  return ops;
};

// FIXME we need to figure out how to optimize this
// but nothing can easily be done until we have a better api
const fetchAllTransactions = async (api, address) => {
  let r;
  let txs = [];
  let maxIteration = 20; // safe limit
  const batch_size = 50; // safe limit
  do {
    r = await api.getTransactions(address, batch_size);
    txs = txs.concat(r.txs);
    if (r.txs.length < batch_size) return txs;
  } while (--maxIteration);
  return txs;
};

async function loadERC20Balances(tokenAccounts, address, api) {
  const erc20balances = await api.getERC20Balances(
    tokenAccounts.map(({ token }) => ({
      contract: token.contractAddress,
      address,
    }))
  );
  return tokenAccounts
    .map((a) => {
      const r = erc20balances.find(
        (b) =>
          b.contract &&
          b.balance &&
          b.contract.toLowerCase() === a.token.contractAddress.toLowerCase()
      );
      if (!r) {
        // when backend have failed in the balance, the TokenAccount should be dropped because it likely means the token no longer is valid.
        return null;
      }
      if (!a.balance.eq(r.balance)) {
        return {
          ...a,
          balance: r.balance,
          spendableBalance: r.balance,
        };
      }
      return a;
    })
    .filter(Boolean);
}

const SAFE_REORG_THRESHOLD = 80;
function stableOperations(a) {
  return a.operations.filter(
    (op) =>
      op.blockHeight && a.blockHeight - op.blockHeight > SAFE_REORG_THRESHOLD
  );
}

// reconciliate the existing token accounts so that refs don't change if no changes is contained
function reconciliateSubAccounts(tokenAccounts, initialAccount) {
  let subAccounts;
  if (initialAccount) {
    const initialSubAccounts = initialAccount.subAccounts;
    let anySubAccountHaveChanged = false;
    const stats = [];
    if (
      initialSubAccounts &&
      tokenAccounts.length !== initialSubAccounts.length
    ) {
      stats.push("length differ");
      anySubAccountHaveChanged = true;
    }
    subAccounts = tokenAccounts.map((ta) => {
      const existing = initialSubAccounts?.find((a) => a.id === ta.id);
      if (existing) {
        let shallowEqual = true;
        if (existing !== ta) {
          for (let k in existing) {
            if (existing[k] !== ta[k]) {
              shallowEqual = false;
              stats.push(`field ${k} changed for ${ta.id}`);
              break;
            }
          }
        }
        if (shallowEqual) {
          return existing;
        } else {
          anySubAccountHaveChanged = true;
        }
      } else {
        anySubAccountHaveChanged = true;
        stats.push(`new token account ${ta.id}`);
      }
      return ta;
    });
    if (!anySubAccountHaveChanged && initialSubAccounts) {
      log(
        "platon",
        "incremental sync: " +
          String(initialSubAccounts.length) +
          " sub accounts have not changed"
      );
      subAccounts = initialSubAccounts;
    } else {
      log(
        "platon",
        "incremental sync: sub accounts changed: " + stats.join(", ")
      );
    }
  } else {
    subAccounts = tokenAccounts.map((a) => a);
  }
  return subAccounts;
}
