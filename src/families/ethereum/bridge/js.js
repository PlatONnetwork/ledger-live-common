// @flow
/* eslint-disable no-param-reassign */
import { Observable } from "rxjs";
import { BigNumber } from "bignumber.js";
import throttle from "lodash/throttle";
import flatMap from "lodash/flatMap";
import uniqBy from "lodash/uniqBy";
import eip55 from "eip55";
import {
  NotEnoughBalance,
  FeeNotLoaded,
  ETHAddressNonEIP,
  InvalidAddress
} from "@ledgerhq/errors";
import { inferDeprecatedMethods } from "../../../bridge/deprecationUtils";
import {
  getDerivationModesForCurrency,
  getDerivationScheme,
  runDerivationScheme,
  isIterableDerivationMode,
  derivationModeSupportsIndex,
  getMandatoryEmptyAccountSkip
} from "../../../derivation";
import {
  getAccountPlaceholderName,
  getNewAccountPlaceholderName
} from "../../../account";
import { getCryptoCurrencyById } from "../../../currencies";
import type { Account, Operation } from "../../../types";
import type { Transaction } from "../types";
import getAddress from "../../../hw/getAddress";
import { open } from "../../../hw";
import { apiForCurrency } from "../../../api/Ethereum";
import { getEstimatedFees } from "../../../api/Fees";
import type { Tx } from "../../../api/Ethereum";
import signTransaction from "../../../hw/signTransaction";
import type { CurrencyBridge, AccountBridge } from "../../../types/bridge";

const serializeTransaction = t => ({
  recipient: t.recipient,
  amount: `0x${BigNumber(t.amount).toString(16)}`,
  gasPrice: !t.gasPrice ? "0x00" : `0x${BigNumber(t.gasPrice).toString(16)}`,
  gasLimit: `0x${BigNumber(t.gasLimit).toString(16)}`
});

// in case of a SELF send, 2 ops are returned.
const txToOps = (account: Account) => (tx: Tx): Operation[] => {
  const freshAddress = account.freshAddress.toLowerCase();
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const sending = freshAddress === from;
  const receiving = freshAddress === to;
  const ops = [];
  // FIXME problem with our api, precision lost here...
  const value = BigNumber(tx.value);
  const fee = BigNumber(tx.gas_price * tx.gas_used);
  if (sending) {
    ops.push({
      id: `${account.id}-${tx.hash}-OUT`,
      hash: tx.hash,
      type: "OUT",
      value: tx.status === 0 ? fee : value.plus(fee),
      fee,
      blockHeight: tx.block && tx.block.height,
      blockHash: tx.block && tx.block.hash,
      accountId: account.id,
      senders: [tx.from],
      recipients: [tx.to],
      date: new Date(tx.received_at),
      extra: {},
      hasFailed: tx.status === 0
    });
  }
  if (receiving) {
    ops.push({
      id: `${account.id}-${tx.hash}-IN`,
      hash: tx.hash,
      type: "IN",
      value,
      fee,
      blockHeight: tx.block && tx.block.height,
      blockHash: tx.block && tx.block.hash,
      accountId: account.id,
      senders: [tx.from],
      recipients: [tx.to],
      date: new Date(new Date(tx.received_at).getTime() + 1), // hack: make the IN appear after the OUT in history.
      extra: {}
    });
  }
  return ops;
};

function isRecipientValid(currency, recipient) {
  if (!recipient.match(/^0x[0-9a-fA-F]{40}$/)) return false;

  // To handle non-eip55 addresses we stop validation here if we detect
  // address is either full upper or full lower.
  // see https://github.com/LedgerHQ/ledger-live-desktop/issues/1397
  const slice = recipient.substr(2);
  const isFullUpper = slice === slice.toUpperCase();
  const isFullLower = slice === slice.toLowerCase();
  if (isFullUpper || isFullLower) return true;

  try {
    return eip55.verify(recipient);
  } catch (error) {
    return false;
  }
}

// Returns a warning if we detect a non-eip address
function getRecipientWarning(currency, recipient) {
  if (!recipient.match(/^0x[0-9a-fA-F]{40}$/)) return null;
  const slice = recipient.substr(2);
  const isFullUpper = slice === slice.toUpperCase();
  const isFullLower = slice === slice.toLowerCase();
  if (isFullUpper || isFullLower) {
    return new ETHAddressNonEIP();
  }
  return null;
}

function mergeOps(existing: Operation[], newFetched: Operation[]) {
  const ids = existing.map(o => o.id);
  const all = newFetched.filter(o => !ids.includes(o.id)).concat(existing);
  return uniqBy(all.sort((a, b) => b.date - a.date), "id");
}

const doSignAndBroadcast = async ({
  a,
  t,
  deviceId,
  isCancelled,
  onSigned,
  onOperationBroadcasted
}) => {
  const { gasPrice, amount, gasLimit } = t;
  if (!gasPrice) throw new FeeNotLoaded();
  const api = apiForCurrency(a.currency);

  const nonce = await api.getAccountNonce(a.freshAddress);

  const transport = await open(deviceId);
  let transaction;
  try {
    transaction = await signTransaction(
      a.currency,
      transport,
      a.freshAddressPath,
      { ...serializeTransaction(t), nonce }
    );
  } finally {
    transport.close();
  }

  if (!isCancelled()) {
    onSigned();

    const hash = await api.broadcastTransaction(transaction);

    onOperationBroadcasted({
      id: `${a.id}-${hash}-OUT`,
      hash,
      type: "OUT",
      value: amount,
      fee: gasPrice.times(gasLimit),
      blockHeight: null,
      blockHash: null,
      accountId: a.id,
      senders: [a.freshAddress],
      recipients: [t.recipient],
      transactionSequenceNumber: nonce,
      date: new Date(),
      extra: {}
    });
  }
};

const SAFE_REORG_THRESHOLD = 80;

const fetchCurrentBlock = (perCurrencyId => currency => {
  if (perCurrencyId[currency.id]) return perCurrencyId[currency.id]();
  const api = apiForCurrency(currency);
  const f = throttle(
    () =>
      api.getCurrentBlock().catch(e => {
        f.cancel();
        throw e;
      }),
    5000
  );
  perCurrencyId[currency.id] = f;
  return f();
})({});

const currencyBridge: CurrencyBridge = {
  scanAccountsOnDevice: (currency, deviceId) =>
    Observable.create(o => {
      let finished = false;
      const unsubscribe = () => {
        finished = true;
      };
      const api = apiForCurrency(currency);

      // in future ideally what we want is:
      // return mergeMap(addressesObservable, address => fetchAccount(address))

      let newAccountCount = 0;

      async function stepAddress(
        index,
        { address, path: freshAddressPath },
        derivationMode,
        shouldSkipEmpty
      ): { account?: Account, complete?: boolean } {
        const balance = await api.getAccountBalance(address);
        if (finished) return { complete: true };
        const currentBlock = await fetchCurrentBlock(currency);
        if (finished) return { complete: true };
        let { txs } = await api.getTransactions(address);
        if (finished) return { complete: true };

        const freshAddress = address;
        const accountId = `ethereumjs:2:${currency.id}:${address}:${derivationMode}`;

        if (txs.length === 0 && balance.isZero()) {
          // this is an empty account
          if (derivationMode === "") {
            // is standard derivation
            if (newAccountCount === 0) {
              // first zero account will emit one account as opportunity to create a new account..
              const account: $Exact<Account> = {
                type: "Account",
                id: accountId,
                seedIdentifier: freshAddress,
                freshAddress,
                freshAddressPath,
                freshAddresses: [
                  {
                    address: freshAddress,
                    derivationPath: freshAddressPath
                  }
                ],
                derivationMode,
                name: getNewAccountPlaceholderName({
                  currency,
                  index,
                  derivationMode
                }),
                balance,
                blockHeight: currentBlock.height,
                index,
                currency,
                operations: [],
                pendingOperations: [],
                unit: currency.units[0],
                lastSyncDate: new Date()
              };
              return { account, complete: true };
            }
            newAccountCount++;
          }

          if (shouldSkipEmpty) {
            return {};
          }
          // NB for legacy addresses maybe we will continue at least for the first 10 addresses
          return { complete: true };
        }

        const account: $Exact<Account> = {
          type: "Account",
          id: accountId,
          seedIdentifier: freshAddress,
          freshAddress,
          freshAddressPath,
          freshAddresses: [
            {
              address: freshAddress,
              derivationPath: freshAddressPath
            }
          ],
          derivationMode,
          name: getAccountPlaceholderName({ currency, index, derivationMode }),
          balance,
          blockHeight: currentBlock.height,
          index,
          currency,
          operations: [],
          pendingOperations: [],
          unit: currency.units[0],
          lastSyncDate: new Date()
        };
        for (let i = 0; i < 50; i++) {
          const last = txs[txs.length - 1];
          if (!last) break;
          const { block } = last;
          if (!block) break;
          const next = await api.getTransactions(
            account.freshAddress,
            block.hash
          );
          if (next.txs.length === 0) break;
          txs = txs.concat(next.txs);
        }
        txs.reverse();
        account.operations = mergeOps([], flatMap(txs, txToOps(account)));
        return { account };
      }

      async function main() {
        let transport;
        try {
          transport = await open(deviceId);
          const derivationModes = getDerivationModesForCurrency(currency);
          for (const derivationMode of derivationModes) {
            let emptyCount = 0;
            const mandatoryEmptyAccountSkip = getMandatoryEmptyAccountSkip(
              derivationMode
            );
            const derivationScheme = getDerivationScheme({
              derivationMode,
              currency
            });
            const stopAt = isIterableDerivationMode(derivationMode) ? 255 : 1;
            for (let index = 0; index < stopAt; index++) {
              if (!derivationModeSupportsIndex(derivationMode, index)) continue;
              const freshAddressPath = runDerivationScheme(
                derivationScheme,
                currency,
                {
                  account: index
                }
              );
              const res = await getAddress(transport, {
                currency,
                path: freshAddressPath,
                derivationMode
              });
              const r = await stepAddress(
                index,
                res,
                derivationMode,
                emptyCount < mandatoryEmptyAccountSkip
              );
              if (process.env.NODE_ENV === "development") {
                /* eslint-disable no-console */
                console.log(
                  `scanning ${currency.id} at ${freshAddressPath}: ${
                    res.address
                  } resulted of ${
                    r.account
                      ? `Account with ${r.account.operations.length} txs`
                      : "no account"
                  }. ${r.complete ? "ALL SCANNED" : ""}`
                );
                /* eslint-enable no-console */
              }
              if (r.account) {
                o.next({ type: "discovered", account: r.account });
              } else {
                emptyCount++;
              }
              if (r.complete) {
                break;
              }
            }
          }
          o.complete();
        } catch (e) {
          o.error(e);
        } finally {
          if (transport) transport.close();
        }
      }

      main();

      return unsubscribe;
    })
};

const startSync = ({ freshAddress, blockHeight, currency, operations }) =>
  Observable.create(o => {
    let unsubscribed = false;
    const api = apiForCurrency(currency);
    async function main() {
      try {
        const block = await fetchCurrentBlock(currency);
        if (unsubscribed) return;
        if (block.height === blockHeight) {
          o.complete();
        } else {
          const filterConfirmedOperations = op =>
            op.blockHeight &&
            blockHeight - op.blockHeight > SAFE_REORG_THRESHOLD;

          operations = operations.filter(filterConfirmedOperations);
          const blockHash =
            operations.length > 0 ? operations[0].blockHash : undefined;
          const { txs } = await api.getTransactions(freshAddress, blockHash);
          if (unsubscribed) return;
          const balance = await api.getAccountBalance(freshAddress);
          if (unsubscribed) return;
          if (txs.length === 0) {
            o.next(a => ({
              ...a,
              balance,
              blockHeight: block.height,
              lastSyncDate: new Date()
            }));
            o.complete();
            return;
          }
          const nonce = await api.getAccountNonce(freshAddress);
          if (unsubscribed) return;
          o.next(a => {
            const currentOps = a.operations.filter(filterConfirmedOperations);
            const newOps = flatMap(txs, txToOps(a));
            const ops = mergeOps(currentOps, newOps);
            const pendingOperations = a.pendingOperations.filter(
              op =>
                op.transactionSequenceNumber &&
                op.transactionSequenceNumber >= nonce &&
                !operations.some(op2 => op2.hash === op.hash)
            );
            return {
              ...a,
              pendingOperations,
              operations: ops,
              balance,
              blockHeight: block.height,
              lastSyncDate: new Date()
            };
          });
          o.complete();
        }
      } catch (e) {
        o.error(e);
      }
    }
    main();

    return () => {
      unsubscribed = true;
    };
  });

const defaultGasLimit = BigNumber(0x5208);

const createTransaction = () => ({
  family: "ethereum",
  amount: BigNumber(0),
  recipient: "",
  gasPrice: null,
  gasLimit: defaultGasLimit,
  networkInfo: null,
  feeCustomUnit: getCryptoCurrencyById("ethereum").units[1]
});

const getTransactionStatus = (a, t) => {
  const estimatedFees = (t.gasPrice || BigNumber(0)).times(t.gasLimit || 0);

  const totalSpent = BigNumber(t.amount || 0).plus(estimatedFees);

  const amount = BigNumber(t.amount || 0);

  const showFeeWarning = amount.gt(0) && estimatedFees.times(10).gt(amount);

  // Fill up transaction errors...
  let transactionError;
  if (!t.gasPrice) {
    transactionError = new FeeNotLoaded();
  } else if (totalSpent.gt(a.balance)) {
    transactionError = new NotEnoughBalance();
  }

  // Fill up recipient errors...
  let recipientError;
  let recipientWarning = getRecipientWarning(a.currency, t.recipient);
  if (!isRecipientValid(a.currency, t.recipient)) {
    recipientError = new InvalidAddress("", {
      currencyName: a.currency.name
    });
  }

  return Promise.resolve({
    transactionError,
    recipientError,
    recipientWarning,
    showFeeWarning,
    estimatedFees,
    amount,
    totalSpent,
    useAllAmount: false
  });
};

const signAndBroadcast = (a, t, deviceId) =>
  Observable.create(o => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const onSigned = () => {
      o.next({ type: "signed" });
    };
    const onOperationBroadcasted = operation => {
      o.next({ type: "broadcasted", operation });
    };
    doSignAndBroadcast({
      a,
      t,
      deviceId,
      isCancelled,
      onSigned,
      onOperationBroadcasted
    }).then(
      () => {
        o.complete();
      },
      e => {
        o.error(e);
      }
    );
    return () => {
      cancelled = true;
    };
  });

const getNetworkInfo = async c => {
  const { gas_price } = await getEstimatedFees(c);
  return { family: "ethereum", gasPrice: BigNumber(gas_price) };
};

const prepareTransaction = async (a, t: Transaction): Promise<Transaction> => {
  const api = apiForCurrency(a.currency);

  const networkInfo = t.networkInfo || (await getNetworkInfo(a.currency));

  const gasLimit = t.recipient
    ? BigNumber(await api.estimateGasLimitForERC20(t.recipient))
    : defaultGasLimit;

  const gasPrice =
    t.gasPrice ||
    (networkInfo.gasPrice ? BigNumber(networkInfo.gasPrice) : null);

  if (
    gasLimit.eq(t.gasLimit) &&
    t.networkInfo === networkInfo &&
    (gasPrice === t.gasPrice ||
      (gasPrice && t.gasPrice && gasPrice.eq(t.gasPrice)))
  ) {
    return t;
  }

  return {
    ...t,
    networkInfo,
    gasLimit,
    gasPrice
  };
};

const fillUpExtraFieldToApplyTransactionNetworkInfo = (a, t, networkInfo) => ({
  gasPrice:
    t.gasPrice ||
    (networkInfo.gas_price ? BigNumber(networkInfo.gas_price) : null)
});

const getCapabilities = () => ({
  canSync: true,
  canSend: true
});

const accountBridge: AccountBridge<Transaction> = {
  createTransaction,
  prepareTransaction,
  getTransactionStatus,
  startSync,
  signAndBroadcast,
  getCapabilities,
  ...inferDeprecatedMethods({
    name: "EthereumJSBridge",
    createTransaction,
    getTransactionStatus,
    prepareTransaction,
    fillUpExtraFieldToApplyTransactionNetworkInfo
  })
};

export default { currencyBridge, accountBridge };
