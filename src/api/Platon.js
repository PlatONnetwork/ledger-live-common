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
  hash: string,
  status?: BigNumber, // 0: fail, 1: success
  received_at?: string,
  nonce: string,
  value: BigNumber,
  gas: BigNumber,
  gas_price: BigNumber,
  from: string,
  to: string,
  cumulative_gas_used?: BigNumber,
  gas_used?: BigNumber,
  transfer_events?: {
    list: Array<{
      contract: string,
      from: string,
      to: string,
      count: BigNumber,
      decimal?: number,
      symbol?: string,
    }>,
    truncated: boolean,
  },
  actions?: Array<{
    from: string,
    to: string,
    value: BigNumber,
    gas?: BigNumber,
    gas_used?: BigNumber,
  }>,
  block?: {
    hash: string,
    height: BigNumber,
    time: string,
  },
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
    block_hash: ?string,
    batch_size?: number
  ) => Promise<{
    truncated: boolean,
    txs: Tx[],
  }>,
  getCurrentBlock: () => Promise<Block>,
  getAccountNonce: (address: string) => Promise<number>,
  broadcastTransaction: (signedTransaction: string) => Promise<string>,
  getERC20Balances: (input: ERC20BalancesInput) => Promise<ERC20BalanceOutput>,
  getAccountBalance: (address: string) => Promise<BigNumber>,
  roughlyEstimateGasLimit: (address: string) => Promise<BigNumber>,
  getERC20ApprovalsPerContract: (
    owner: string,
    contract: string
  ) => Promise<Array<{ sender: string, value: string }>>,
  getDryRunGasLimit: (
    address: string,
    request: EthereumGasLimitRequest
  ) => Promise<BigNumber>,
  getGasTrackerBarometer: () => Promise<{
    low: BigNumber,
    medium: BigNumber,
    high: BigNumber,
  }>,
};

export const apiForCurrency = (currency: CryptoCurrency): API => {
  const baseURL = 'http://192.168.120.146:6789';

  return {
    async getTransactions(address, block_hash, batch_size = 2000) {
      let { data } = await network({
        method: "POST",
        url: 'http://192.168.9.190:40000/browser-server/transaction/transactionListByAddress',
        data: {pageNo: 1, pageSize: 200, address},
      });
      console.log('=====> ', data)
      data = {
        truncated: data.data.length > 200,
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

    async roughlyEstimateGasLimit(address) {
      // const { data } = await network({
      //   method: "POST",
      //   url: baseURL,
      //   data: {
      //     "jsonrpc":"2.0",
      //     "method":"platon_estimateGas",
      //     "params":[],
      //     "id":1
      //   },
      //   transformResponse: JSONBigNumber.parse,
      // });
      // return BigNumber(data.estimated_gas_limit);
      return BigNumber(2100);
    },

    async getDryRunGasLimit(address, request) {
      const post: Object = {
        ...request,
      };
      // .to not needed by backend as it's part of URL:
      delete post.to;
      // backend use gas_price casing:
      post.gas_price = request.gasPrice;
      delete post.gasPrice;

      const { data } = await network({
        method: "POST",
        url: `${baseURL}/addresses/${address}/estimate-gas-limit`,
        data: post,
        transformResponse: JSONBigNumber.parse,
      });
      if (data.error_message) {
        throw new FeeEstimationFailed(data.error_message);
      }
      const value = BigNumber(data.estimated_gas_limit);
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
        return {
          low: BigNumber(data),
          medium: BigNumber(data),
          high: BigNumber(data),
        };
      },
      () => "",
      { maxAge: 30 * 1000 }
    ),
  };
};
