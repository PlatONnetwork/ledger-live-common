// @flow
import { BigNumber } from "bignumber.js";
import network from "../../../network";

const baseURL = 'http://192.168.120.146:6789';

export const getTransactions = async(address: string) => {
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
};

export const getCurrentBlock = async() => {
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
};

export const getAccountNonce = async(address:string) => {
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
};

export const broadcastTransaction = async(tx:string) => {
  const { data } = await network({
    method: "POST",
    url: baseURL,
    data: {
      "jsonrpc":"2.0",
      "method":"platon_sendRawTransaction",
      "params":[{
        "data": tx
      }],
      "id":1
    },
  });
  return data.result;
};

export const getAccountBalance = async(address: string) => {
  const { data } = await network({
    method: "POST",
    url: baseURL,
    data: {
      "jsonrpc":"2.0",
      "method":"platon_getBalance",
      "params":[address, "latest"],
      "id":1
    },
  });
  return BigNumber(data.result);
};

/**
 * Get all account-related data
 *
 * @async
 * @param {*} address
 */
 export const fetchAccount = async (address: string) => {
   const [blockHeight, balance] = await Promise.all([getCurrentBlock(), getAccountBalance(address)])

  return {
    blockHeight,
    balance
  };
};

/**
 * Fetch all operations for a single account from indexer
 *
 * @param {string} accountId
 * @param {string} addr
 * @param {number} startAt - blockHeight after which you fetch this op (included)
 *
 * @return {Operation[]}
 */
export const fetchOperations = async (
  accountId: string,
  addr: string,
  startAt: number = 0
) => {
  const operations = await getTransactions(addr)
  return [operations];
};
