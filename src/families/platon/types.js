// @flow

import type { BigNumber } from "bignumber.js";
import type {
  Unit,
  Account,
  TransactionStatus,
  TokenCurrency,
  Operation,
} from "../../types";
import type {
  TransactionCommon,
  TransactionCommonRaw,
} from "../../types/transaction";
import type {
  CoreAmount,
  CoreBigInt,
  OperationType,
  Spec,
} from "../../libcore/types";
import type { TransactionMode, ModeModule } from "./modules";
import type { CryptoCurrency } from "../../types";
import type { DerivationMode } from "../../derivation";

export type EthereumGasLimitRequest = {
  from?: string,
  to?: string,
  value?: string,
  data?: string,
  gas?: string,
  gasPrice?: string,
  amplifier: string,
};

export type NetworkInfo = {|
  family: "platon",
  gasPrice: BigNumber,
|};

export type NetworkInfoRaw = {|
  family: "platon",
  gasPrice: string,
|};

export type { TransactionMode, ModeModule };

export type Transaction = {|
  ...TransactionCommon,
  family: "platon",
  mode: TransactionMode,
  nonce?: number,
  data?: Buffer,
  gasPrice: ?BigNumber,
  userGasLimit: ?BigNumber,
  estimatedGasLimit: ?BigNumber,
  feeCustomUnit: ?Unit,
  networkInfo: ?NetworkInfo,
  allowZeroAmount?: boolean,
  isBech32?: boolean,
|};

export type TransactionRaw = {|
  ...TransactionCommonRaw,
  family: "platon",
  mode: TransactionMode,
  nonce?: number,
  data?: string,
  gasPrice: ?string,
  userGasLimit: ?string,
  estimatedGasLimit: ?string,
  feeCustomUnit: ?Unit,
  networkInfo: ?NetworkInfoRaw,
  allowZeroAmount?: boolean,
|};

export type TypedMessage = {
  types: {
    EIP712Domain: [{ type: string, name: string }],
    [key: string]: [{ type: string, name: string }],
  },
  primaryType: string,
  domain: any,
  message: any,
  hashes: {
    domainHash: string,
    messageHash: string,
  },
};

export type TypedMessageData = {
  currency: CryptoCurrency,
  path: string,
  verify?: boolean,
  derivationMode: DerivationMode,
  message: TypedMessage,
  hashes: {
    stringHash: string,
  },
};

//

export type CoreStatics = {};
export type CoreAccountSpecifics = {};
export type CoreOperationSpecifics = {};
export type CoreCurrencySpecifics = {};
export const reflect = (_declare: *) => {};
