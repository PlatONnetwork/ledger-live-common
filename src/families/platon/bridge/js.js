// @flow
import invariant from "invariant";
import { BigNumber } from "bignumber.js";
import {
  NotEnoughGas,
  FeeNotLoaded,
  FeeRequired,
  GasLessThanEstimate,
} from "@ledgerhq/errors";
import type { CurrencyBridge, AccountBridge } from "../../../types";
import {
  makeSync,
  makeScanAccounts,
  makeAccountBridgeReceive,
} from "../../../bridge/jsHelpers";
import { getMainAccount } from "../../../account";
import { patchOperationWithHash } from "../../../operation";
import { getCryptoCurrencyById } from "../../../currencies";
import { apiForCurrency } from "../../../api/Platon";
import { getEstimatedFees } from "../../../api/Fees";
import type { Transaction, NetworkInfo } from "../types";
import {
  getGasLimit,
  inferEthereumGasLimitRequest,
  estimateGasLimit,
} from "../transaction";
import { getAccountShape } from "../synchronisation";
import { preload, hydrate } from "../modules";
import { signOperation } from "../signOperation";
import { modes } from "../modules";
import postSyncPatch from "../postSyncPatch";
import {
  toBech32Address,
  decodeBech32Address,
  isBech32Address,
  isAddress,
} from "../utils.min.js";

const receive = makeAccountBridgeReceive();

const broadcast = async ({
  account,
  signedOperation: { operation, signature },
}) => {
  const api = apiForCurrency(account.currency);
  const hash = await api.broadcastTransaction(signature);
  return patchOperationWithHash(operation, hash);
};

const scanAccounts = makeScanAccounts(getAccountShape);

const sync = makeSync(getAccountShape, postSyncPatch);

const createTransaction = () => ({
  family: "platon",
  mode: "send",
  amount: BigNumber(0),
  recipient: "",
  gasPrice: null,
  userGasLimit: null,
  estimatedGasLimit: null,
  networkInfo: null,
  feeCustomUnit: getCryptoCurrencyById("platon").units[0],
  useAllAmount: false,
  isBech32: false,
});

const updateTransaction = (t, patch) => {
  console.log("_-_-_-_=> updateTransaction", t);

  if ("recipient" in patch && patch.recipient !== t.recipient) {
    return { ...t, ...patch, userGasLimit: null, estimatedGasLimit: null };
  }
  return { ...t, ...patch };
};

const getTransactionStatus = (a, t) => {
  console.log("_-_-_-_=> getTransactionStatus", t);
  t.isBech32 && (t.recipient = decodeBech32Address(t.recipient));
  const gasLimit = getGasLimit(t);
  const estimatedFees = (t.gasPrice || BigNumber(0)).times(gasLimit);

  const errors = {};
  const warnings = {};
  const result = {
    errors,
    warnings,
    estimatedFees,
    amount: BigNumber(0),
    totalSpent: BigNumber(0),
  };

  const m = modes[t.mode];
  invariant(m, "missing module for mode=" + t.mode);
  m.fillTransactionStatus(a, t, result);

  // generic gas error and warnings
  if (!t.gasPrice) {
    errors.gasPrice = new FeeNotLoaded();
  } else if (gasLimit.eq(0)) {
    errors.gasLimit = new FeeRequired();
  } else if (!errors.recipient) {
    if (estimatedFees.gt(a.balance)) {
      errors.gasPrice = new NotEnoughGas();
    }
  }

  if (t.estimatedGasLimit && gasLimit.lt(t.estimatedGasLimit)) {
    warnings.gasLimit = new GasLessThanEstimate();
  }

  return Promise.resolve(result);
};

const getNetworkInfoByGasTrackerBarometer = async (c) => {
  console.log("_-_-_-_=> getNetworkInfoByGasTrackerBarometer");
  const api = apiForCurrency(c);
  const gasPrice = await api.getGasTrackerBarometer();
  return { family: "platon", gasPrice };
};

const getNetworkInfo = (c) =>
  getNetworkInfoByGasTrackerBarometer(c).catch((e) => {
    throw e;
  });

const prepareTransaction = async (a, t: Transaction): Promise<Transaction> => {
  console.log("_-_-_-_=> prepareTransaction", t);
  if (isBech32Address(t.recipient)) {
    t.isBech32 = true;
    t.recipient = decodeBech32Address(t.recipient)
  }
  const networkInfo = t.networkInfo || (await getNetworkInfo(a.currency));
  const gasPrice = networkInfo.gasPrice;
  if (t.gasPrice !== gasPrice || t.networkInfo !== networkInfo) {
    t = { ...t, networkInfo, gasPrice };
  }

  let estimatedGasLimit;
  const request = inferEthereumGasLimitRequest(a, t);
  if (request.to) {
    request.to = toBech32Address(request.to);
    estimatedGasLimit = await estimateGasLimit(a, request);
  }

  if (
    !t.estimatedGasLimit ||
    (estimatedGasLimit && !estimatedGasLimit.eq(t.estimatedGasLimit))
  ) {
    t.estimatedGasLimit = estimatedGasLimit;
  }

  return t;
};

const estimateMaxSpendable = async ({
  account,
  parentAccount,
  transaction,
}) => {
  console.log("_-_-_-_=> estimateMaxSpendable");
  const mainAccount = getMainAccount(account, parentAccount);
  const t = await prepareTransaction(mainAccount, {
    ...createTransaction(),
    subAccountId: account.type === "Account" ? null : account.id,
    ...transaction,
    recipient:
      transaction?.recipient || "0x0000000000000000000000000000000000000000",

    useAllAmount: true,
  });
  const s = await getTransactionStatus(mainAccount, t);
  return s.amount;
};

const getPreloadStrategy = (_currency) => ({
  preloadMaxAge: 30 * 1000,
});

const currencyBridge: CurrencyBridge = {
  getPreloadStrategy,
  preload,
  hydrate,
  scanAccounts,
};

const accountBridge: AccountBridge<Transaction> = {
  createTransaction,
  updateTransaction,
  prepareTransaction,
  estimateMaxSpendable,
  getTransactionStatus,
  sync,
  receive,
  signOperation,
  broadcast,
};

export default { currencyBridge, accountBridge };
