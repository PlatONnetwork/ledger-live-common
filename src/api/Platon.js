// @flow
import URL from "url";
import invariant from "invariant";
import { BigNumber } from "bignumber.js";
import { LedgerAPINotAvailable } from "@ledgerhq/errors";
import JSONBigNumber from "../JSONBigNumber";
import type { CryptoCurrency } from "../types";
import type { EthereumGasLimitRequest } from "../families/ethereum/types";
import network from "../network";
// import { blockchainBaseURL } from "./Ledger";
import { FeeEstimationFailed } from "../errors";
import { makeLRUCache } from "../cache";

export type Block = { height: BigNumber }; // TODO more fields actually

export type Tx = {
  txHash: string,
  txReceiptStatus?: BigNumber, // 0: fail, 1: success
  serverTime?: string,
  blockHash?: string,
  value: BigNumber,
  actualTxCost: BigNumber,
  from: string,
  to: string,
  blockNumber: number,
};

export type ERC20BalancesInput = Array<{
  address: string,
  contract: string,
}>;

export type ERC20BalanceOutput = Array<{
  address: string,
  contract: string,
  balance: BigNumber,
}>;

export type API = {
  getTransactions: (
    address: string,
    batch_size?: number
  ) => Promise<{
    truncated: boolean,
    txs: Tx[],
  }>,
  getCurrentBlock: () => Promise<number>,
  getAccountNonce: (address: string) => Promise<number>,
  broadcastTransaction: (signedTransaction: string) => Promise<string>,
  getERC20Balances: (input: ERC20BalancesInput) => Promise<ERC20BalanceOutput>,
  getAccountBalance: (address: string) => Promise<BigNumber>,
  roughlyEstimateGasLimit: () => Promise<BigNumber>,
  getERC20ApprovalsPerContract: (
    owner: string,
    contract: string
  ) => Promise<Array<{ sender: string, value: string }>>,
  getDryRunGasLimit: (
    request: EthereumGasLimitRequest
  ) => Promise<BigNumber>,
  getGasTrackerBarometer: () => Promise<BigNumber>,
};

export const apiForCurrency = (currency: CryptoCurrency): API => {
  const baseURL = 'http://192.168.120.146:6789';

  return {
    async getTransactions(address, batch_size) {
      console.log('_-_-_-_=> getTransactions');
      let { data } = await network({
        method: "POST",
        url: 'http://192.168.9.190:40000/browser-server/transaction/transactionListByAddress',
        data: {pageNo: 1, pageSize: batch_size, address},
      });
      data = {
        truncated: data.data.length >= batch_size,
        txs: data.data || [],
      };
      return data;
    },

    async getCurrentBlock() {
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_blockNumber",
          "params":[],
          "id":1
        },
      });
      return data.result;
    },

    async getAccountNonce(address) {
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_getTransactionCount",
          "params":[address, 'latest'],
          "id":1
        },
      });
      return data.result;
    },

    async broadcastTransaction(tx) {
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_sendRawTransaction",
          "params":[tx],
          "id":1
        },
      });
      return data.result;
    },

    async getAccountBalance(address) {
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_getBalance",
          "params":[address, "latest"],
          "id":1
        },
        transformResponse: JSONBigNumber.parse,
      });
      return BigNumber(data.result);
    },

    async getERC20Balances(input) {
      const { data } = await network({
        method: "POST",
        url: `${baseURL}/erc20/balances`,
        transformResponse: JSONBigNumber.parse,
        data: input,
      });
      return data;
    },

    async getERC20ApprovalsPerContract(owner, contract) {
      try {
        const { data } = await network({
          method: "GET",
          url: URL.format({
            pathname: `${baseURL}/erc20/approvals`,
            query: {
              owner,
              contract,
            },
          }),
        });
        return data
          .map((m: mixed) => {
            if (!m || typeof m !== "object") return;
            const { sender, value } = m;
            if (typeof sender !== "string" || typeof value !== "string") return;
            return { sender, value };
          })
          .filter(Boolean);
      } catch (e) {
        if (e.status === 404) {
          return [];
        }
        throw e;
      }
    },

    async roughlyEstimateGasLimit() {
      console.log('_-_-_-_=> roughlyEstimateGasLimit');
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_estimateGas",
          "params":[{}],
          "id":1
        },
        transformResponse: JSONBigNumber.parse,
      });
      return BigNumber(data.result);
    },

    async getDryRunGasLimit(tx) {
      console.log('_-_-_-_=> getDryRunGasLimit');
      const { data } = await network({
        method: "POST",
        url: baseURL,
        data: {
          "jsonrpc":"2.0",
          "method":"platon_estimateGas",
          "params":[{
            "from": tx.from,
            "to": tx.to,
            "data": tx.data
          }],
          "id":1
        },
        transformResponse: JSONBigNumber.parse,
      });
      if (data.error && data.error.message) {
        throw new FeeEstimationFailed(data.error.message);
      }
      const value = BigNumber(data.result);
      invariant(!value.isNaN(), "invalid server data");
      return value;
    },

    getGasTrackerBarometer: makeLRUCache(
      async () => {
        const { data } = await network({
          method: "POST",
          url: baseURL,
          data: {
            "jsonrpc":"2.0",
            "method":"platon_gasPrice",
            "params":[],
            "id":1
          }
        });
        return BigNumber(data.result);
      },
      () => "",
      { maxAge: 30 * 1000 }
    ),
  };
};
