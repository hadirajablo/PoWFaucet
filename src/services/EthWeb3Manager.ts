
import Web3 from 'web3';
import { Contract } from 'web3-eth-contract';
import { AbiItem } from 'web3-utils';
import net from 'net';
import { TransactionReceipt } from 'web3-core';
import * as EthCom from '@ethereumjs/common';
import * as EthTx from '@ethereumjs/tx';
import * as EthUtil from 'ethereumjs-util';
import { TypedEmitter } from 'tiny-typed-emitter';
import { faucetConfig } from '../common/FaucetConfig';
import { ServiceManager } from '../common/ServiceManager';
import { FaucetProcess, FaucetLogLevel } from '../common/FaucetProcess';
import { FaucetStatus, FaucetStatusLevel } from './FaucetStatus';
import { strFormatPlaceholder } from '../utils/StringUtils';
import { FaucetStatsLog } from './FaucetStatsLog';
import { PromiseDfd } from '../utils/PromiseDfd';
import { FaucetStoreDB } from './FaucetStoreDB';
import { PoWRewardLimiter } from './PoWRewardLimiter';
import ERC20_ABI from '../abi/ERC20.json';

interface WalletState {
  ready: boolean;
  nonce: number;
  balance: bigint;
  nativeBalance: bigint;
}

interface FaucetTokenState {
  address: string;
  decimals: number;
  contract: Contract;
  getBalance(addr: string): Promise<bigint>;
  getTransferData(addr: string, amount: bigint): string;
}

export enum ClaimTxStatus {
  QUEUE = "queue",
  PROCESSING = "processing",
  PENDING = "pending",
  CONFIRMED = "confirmed",
  FAILED = "failed",
}

export enum FaucetCoinType {
  NATIVE = "native",
  ERC20 = "erc20",
}

enum FucetWalletState {
  UNKNOWN = 0,
  NORMAL = 1,
  LOWFUNDS = 2,
  NOFUNDS = 3,
  OFFLINE = 4,
}

export interface ClaimTxEvents {
  'processing': () => void;
  'pending': () => void;
  'confirmed': () => void;
  'failed': () => void;
}

export interface IQueuedClaimTx {
  time: number;
  target: string;
  amount: string;
  session: string;
}

export class ClaimTx extends TypedEmitter<ClaimTxEvents> {
  public queueIdx: number;
  public status: ClaimTxStatus;
  public readonly time: Date;
  public readonly target: string;
  public readonly amount: bigint;
  public readonly session: string;
  public nonce: number;
  public txhex: string;
  public txhash: string;
  public txblock: number;
  public txfee: bigint;
  public retryCount: number;
  public failReason: string;

  public constructor(target: string, amount: bigint, sessId: string, date?: number) {
    super();
    this.status = ClaimTxStatus.QUEUE;
    this.time = date ? new Date(date) : new Date();
    this.target = target;
    this.amount = amount;
    this.session = sessId;
    this.txfee = 0n;
    this.retryCount = 0;
  }

  public serialize(): IQueuedClaimTx {
    return {
      time: this.time.getTime(),
      target: this.target,
      amount: this.amount.toString(),
      session: this.session,
    };
  }

}

export class EthWeb3Manager {
  private web3: Web3;
  private chainCommon: EthCom.default;
  private walletKey: Buffer;
  private walletAddr: string;
  private walletState: WalletState;
  private tokenState: FaucetTokenState;
  private claimTxQueue: ClaimTx[] = [];
  private pendingTxQueue: {[hash: string]: ClaimTx} = {};
  private historyTxDict: {[nonce: number]: ClaimTx} = {};
  private lastWalletRefresh: number;
  private queueProcessing: boolean = false;
  private lastClaimTxIdx: number = 1;
  private lastProcessedClaimTxIdx: number = 0;
  private lastWalletRefill: number;
  private lastWalletRefillTry: number;
  private walletRefilling: boolean;

  public constructor() {
    this.startWeb3();
    if(typeof faucetConfig.ethChainId === "number")
      this.initChainCommon(faucetConfig.ethChainId);
    
    this.walletKey = Buffer.from(faucetConfig.ethWalletKey, "hex");
    this.walletAddr = EthUtil.toChecksumAddress("0x"+EthUtil.privateToAddress(this.walletKey).toString("hex"));

    // restore saved claimTx queue
    ServiceManager.GetService(FaucetStoreDB).getClaimTxQueue().forEach((claimTx) => {
      let claim = new ClaimTx(claimTx.target, BigInt(claimTx.amount), claimTx.session, claimTx.time);
      claim.queueIdx = this.lastClaimTxIdx++;
      this.claimTxQueue.push(claim);
    });

    this.loadWalletState().then(() => {
      setInterval(() => this.processQueue(), 2000);
    });

    // reload handler
    ServiceManager.GetService(FaucetProcess).addListener("reload", () => {
      this.startWeb3();
      this.lastWalletRefresh = 0;
    });
  }

  private initChainCommon(chainId: number) {
    if(this.chainCommon && this.chainCommon.chainIdBN().toNumber() === chainId)
      return;
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Web3 ChainCommon initialized with chainId " + chainId);
    this.chainCommon = EthCom.default.forCustomChain('mainnet', {
      networkId: chainId,
      chainId: chainId,
    }, 'london');
  }

  private startWeb3() {
    let provider: any;
    if(faucetConfig.ethRpcHost.match(/^wss?:\/\//))
      provider = new Web3.providers.WebsocketProvider(faucetConfig.ethRpcHost);
    else if(faucetConfig.ethRpcHost.match(/^\//))
      provider = new Web3.providers.IpcProvider(faucetConfig.ethRpcHost, net);
    else
      provider = new Web3.providers.HttpProvider(faucetConfig.ethRpcHost);
    
    this.web3 = new Web3(provider);

    if(faucetConfig.faucetCoinType !== FaucetCoinType.NATIVE)
      this.initWeb3Token();
    else
      this.tokenState = null;

    if(provider.on) {
      provider.on('error', e => {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Web3 provider error: " + e.toString());
      });
      provider.on('end', e => {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Web3 connection lost...");
        this.web3 = null;

        setTimeout(() => {
          this.startWeb3();
        }, 2000);
      });
    }
  }

  private initWeb3Token() {
    let tokenContract: Contract = null;
    switch(faucetConfig.faucetCoinType) {
      case FaucetCoinType.ERC20:
        tokenContract = new this.web3.eth.Contract(ERC20_ABI as AbiItem[], faucetConfig.faucetCoinContract, {
          from: this.walletAddr,
        });
        this.tokenState = {
          address: faucetConfig.faucetCoinContract,
          contract: tokenContract,
          decimals: 0,
          getBalance: (addr: string) => tokenContract.methods['balanceOf'](addr).call(),
          getTransferData: (addr: string, amount: bigint) => tokenContract.methods['transfer'](addr, amount).encodeABI(),
        };
        tokenContract.methods['decimals']().call().then((res) => {
          this.tokenState.decimals = parseInt(res);
        });
        break;
      default:
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Unknown coin type: " + faucetConfig.faucetCoinType);
        return;
    }
  }

  public getTransactionQueue(queueOnly?: boolean): ClaimTx[] {
    let txlist: ClaimTx[] = [];
    Array.prototype.push.apply(txlist, this.claimTxQueue);
    if(!queueOnly) {
      Array.prototype.push.apply(txlist, Object.values(this.pendingTxQueue));
      Array.prototype.push.apply(txlist, Object.values(this.historyTxDict));
    }
    return txlist;
  }

  private loadWalletState(): Promise<void> {
    this.lastWalletRefresh = Math.floor(new Date().getTime() / 1000);
    let chainIdPromise = typeof faucetConfig.ethChainId === "number" ? Promise.resolve(faucetConfig.ethChainId) : this.web3.eth.getChainId();
    let tokenBalancePromise = this.tokenState?.getBalance(this.walletAddr);
    return Promise.all([
      this.web3.eth.getBalance(this.walletAddr, "pending"),
      this.web3.eth.getTransactionCount(this.walletAddr, "pending"),
      chainIdPromise,
      tokenBalancePromise,
    ]).catch((ex) => {
      if(ex.toString().match(/"pending" is not yet supported/)) {
        return Promise.all([
          this.web3.eth.getBalance(this.walletAddr),
          this.web3.eth.getTransactionCount(this.walletAddr),
          chainIdPromise,
          tokenBalancePromise,
        ]);
      }
      else
        throw ex;
    }).then((res) => {
      this.initChainCommon(res[2]);
      this.walletState = {
        ready: true,
        balance: this.tokenState ? BigInt(res[3]) : BigInt(res[0]),
        nativeBalance: BigInt(res[0]),
        nonce: res[1],
      };
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Wallet " + this.walletAddr + ":  " + this.readableAmount(this.walletState.balance) + "  [Nonce: " + this.walletState.nonce + "]");
    }, (err) => {
      this.walletState = {
        ready: false,
        balance: 0n,
        nativeBalance: 0n,
        nonce: 0,
      };
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Error loading wallet state for " + this.walletAddr + ": " + err.toString());
    }).then(() => {
      this.updateFaucetStatus();
    });
  }

  private updateFaucetStatus() {
    let newStatus = FucetWalletState.UNKNOWN;
    if(this.walletState) {
      newStatus = FucetWalletState.NORMAL;
      if(!this.walletState.ready)
        newStatus = FucetWalletState.OFFLINE;
      else if(this.walletState.balance <= faucetConfig.noFundsBalance)
        newStatus = FucetWalletState.NOFUNDS;
      else if(this.walletState.nativeBalance <= BigInt(faucetConfig.ethTxGasLimit) * BigInt(faucetConfig.ethTxMaxFee))
        newStatus = FucetWalletState.NOFUNDS;
      else if(this.walletState.balance <= faucetConfig.lowFundsBalance)
        newStatus = FucetWalletState.LOWFUNDS;
    }
    let statusMessage: string = null;
    let statusLevel: FaucetStatusLevel = null;
    switch(newStatus) {
      case FucetWalletState.LOWFUNDS:
        if(typeof faucetConfig.lowFundsWarning === "string")
          statusMessage = faucetConfig.lowFundsWarning;
        else if(faucetConfig.lowFundsWarning)
          statusMessage = "The faucet is running out of funds! Faucet Balance: {1}";
        else
          break;
        statusMessage = strFormatPlaceholder(statusMessage, this.readableAmount(this.walletState.balance));
        statusLevel = FaucetStatusLevel.WARNING;
        break;
      case FucetWalletState.NOFUNDS:
        if(typeof faucetConfig.noFundsError === "string")
          statusMessage = faucetConfig.noFundsError;
        else if(faucetConfig.noFundsError)
          statusMessage = "The faucet is out of funds!";
        else
          break;
        statusMessage = strFormatPlaceholder(statusMessage);
        statusLevel = FaucetStatusLevel.ERROR;
        break;
      case FucetWalletState.OFFLINE:
        if(typeof faucetConfig.rpcConnectionError === "string")
          statusMessage = faucetConfig.rpcConnectionError;
        else if(faucetConfig.rpcConnectionError)
          statusMessage = "The faucet could not connect to the network RPC";
        else
          break;
        statusMessage = strFormatPlaceholder(statusMessage);
        statusLevel = FaucetStatusLevel.ERROR;
        break;
    }
    ServiceManager.GetService(FaucetStatus).setFaucetStatus("wallet", statusMessage, statusLevel);
  }

  public getFaucetAddress(): string {
    return this.walletAddr;
  }

  public getFaucetDecimals(native?: boolean): number {
    return ((this.tokenState && !native) ? this.tokenState.decimals : 18) || 18;
  }

  public decimalUnitAmount(amount: bigint, native?: boolean): number {
    let decimals = this.getFaucetDecimals(native);
    let factor = Math.pow(10, decimals);
    return parseInt(amount.toString()) / factor;
  }

  public readableAmount(amount: bigint, native?: boolean): string {
    let amountStr = (Math.floor(this.decimalUnitAmount(amount, native) * 1000) / 1000).toString();
    return amountStr + " " + (native ? "ETH" : faucetConfig.faucetCoinSymbol);
  }

  public async getWalletBalance(addr: string): Promise<bigint> {
    if(this.tokenState)
      return await this.tokenState.getBalance(addr);
    else
      return BigInt(await this.web3.eth.getBalance(addr));
  }

  public checkIsContract(addr: string): Promise<boolean> {
    return this.web3.eth.getCode(addr).then((res) => res && !!res.match(/^0x[0-9a-f]{2,}$/));
  }

  public getFaucetBalance(native?: boolean): bigint | null {
    if(native)
      return this.walletState?.nativeBalance || null;
    else
      return this.walletState?.balance || null;
  }

  public getQueuedAmount(): bigint | null {
    let totalPending = 0n;
    this.claimTxQueue.forEach((claimTx) => {
      totalPending += claimTx.amount;
    });
    return totalPending;
  }

  public getLastProcessedClaimIdx(): number {
    return this.lastProcessedClaimTxIdx;
  }

  public addClaimTransaction(target: string, amount: bigint, sessId: string): ClaimTx {
    let claimTx = new ClaimTx(target, amount, sessId);
    claimTx.queueIdx = this.lastClaimTxIdx++;
    this.claimTxQueue.push(claimTx);
    ServiceManager.GetService(FaucetStoreDB).addQueuedClaimTx(claimTx.serialize());
    return claimTx;
  }

  public getClaimTransaction(sessId: string): ClaimTx {
    for(let i = 0; i < this.claimTxQueue.length; i++) {
      if(this.claimTxQueue[i].session === sessId)
        return this.claimTxQueue[i];
    }
    
    let pendingTxs = Object.values(this.pendingTxQueue);
    for(let i = 0; i < pendingTxs.length; i++) {
      if(pendingTxs[i].session === sessId)
        return pendingTxs[i];
    }

    let historyTxs = Object.values(this.historyTxDict);
    for(let i = 0; i < historyTxs.length; i++) {
      if(historyTxs[i].session === sessId)
        return historyTxs[i];
    }

    return null;
  }

  private async buildEthTx(target: string, amount: bigint, nonce: number, data?: string, gasLimit?: number): Promise<string> {
    if(target.match(/^0X/))
      target = "0x" + target.substring(2);

    let tx: EthTx.Transaction | EthTx.FeeMarketEIP1559Transaction;
    if(faucetConfig.ethLegacyTx) {
      // legacy transaction
      let gasPrice = parseInt(await this.web3.eth.getGasPrice());
      gasPrice += faucetConfig.ethTxPrioFee;
      if(faucetConfig.ethTxMaxFee > 0 && gasPrice > faucetConfig.ethTxMaxFee)
        gasPrice = faucetConfig.ethTxMaxFee;

      tx = EthTx.Transaction.fromTxData({
        nonce: nonce,
        gasLimit: gasLimit || faucetConfig.ethTxGasLimit,
        gasPrice: gasPrice,
        to: target,
        value: "0x" + amount.toString(16),
        data: data ? data : "0x"
      }, {
        common: this.chainCommon
      });
    }
    else {
      // eip1559 transaction
      tx = EthTx.FeeMarketEIP1559Transaction.fromTxData({
        nonce: nonce,
        gasLimit: gasLimit || faucetConfig.ethTxGasLimit,
        maxPriorityFeePerGas: faucetConfig.ethTxPrioFee,
        maxFeePerGas: faucetConfig.ethTxMaxFee,
        to: target,
        value: "0x" + amount.toString(16),
        data: data ? data : "0x"
      }, {
        common: this.chainCommon
      });
    }

    tx = tx.sign(this.walletKey);
    return tx.serialize().toString('hex');
  }

  private async processQueue() {
    if(this.queueProcessing)
      return;
    this.queueProcessing = true;

    try {
      while(Object.keys(this.pendingTxQueue).length < faucetConfig.ethMaxPending && this.claimTxQueue.length > 0) {
        if(faucetConfig.ethQueueNoFunds && (
          !this.walletState.ready || 
          this.walletState.balance - BigInt(faucetConfig.spareFundsAmount) < this.claimTxQueue[0].amount ||
          this.walletState.nativeBalance <= BigInt(faucetConfig.ethTxGasLimit) * BigInt(faucetConfig.ethTxMaxFee)
        )) {
          break; // skip processing (out of funds)
        }

        let claimTx = this.claimTxQueue.splice(0, 1)[0];
        this.lastProcessedClaimTxIdx = claimTx.queueIdx;
        await this.processQueueTx(claimTx);
      }

      let now = Math.floor(new Date().getTime() / 1000);
      let walletRefreshTime = this.walletState.ready ? 600 : 10;
      if(Object.keys(this.pendingTxQueue).length === 0 && now - this.lastWalletRefresh > walletRefreshTime) {
        await this.loadWalletState();
      }

      if(faucetConfig.ethRefillContract && this.walletState.ready)
        await this.tryRefillWallet();
    } catch(ex) {
      let stack;
      try {
        throw new Error();
      } catch(ex) {
        stack = ex.stack;
      }
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Exception in transaction queue processing: " + ex.toString() + `\r\n   Stack Trace: ${ex && ex.stack ? ex.stack : stack}`);
    }
    this.queueProcessing = false;
  }

  private sleepPromise(delay: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }

  private async processQueueTx(claimTx: ClaimTx) {
    if(!this.walletState.ready) {
      claimTx.failReason = "Network RPC is currently unreachable.";
      claimTx.status = ClaimTxStatus.FAILED;
      claimTx.emit("failed");
      ServiceManager.GetService(FaucetStoreDB).removeQueuedClaimTx(claimTx.session);
      return;
    }
    if(
      !this.walletState.ready || 
      this.walletState.balance - BigInt(faucetConfig.spareFundsAmount) < claimTx.amount ||
      this.walletState.nativeBalance <= BigInt(faucetConfig.ethTxGasLimit) * BigInt(faucetConfig.ethTxMaxFee)
    ) {
      claimTx.failReason = "Faucet wallet is out of funds.";
      claimTx.status = ClaimTxStatus.FAILED;
      claimTx.emit("failed");
      ServiceManager.GetService(FaucetStoreDB).removeQueuedClaimTx(claimTx.session);
      return;
    }

    try {
      claimTx.status = ClaimTxStatus.PROCESSING;
      claimTx.emit("processing");

      // send transaction
      let txPromise: Promise<TransactionReceipt>;
      let retryCount = 0;
      let txError: Error;
      let buildTx = () => {
        claimTx.nonce = this.walletState.nonce;
        if(this.tokenState)
          return this.buildEthTx(this.tokenState.address, 0n, claimTx.nonce, this.tokenState.getTransferData(claimTx.target, claimTx.amount));
        else
          return this.buildEthTx(claimTx.target, claimTx.amount, claimTx.nonce);
      };

      do {
        try {
          claimTx.txhex = await buildTx();
          let txResult = await this.sendTransaction(claimTx.txhex);
          claimTx.txhash = txResult[0];
          txPromise = txResult[1];
        } catch(ex) {
          if(!txError)
            txError = ex;
          ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Sending TX for " + claimTx.target + " failed [try: " + retryCount + "]: " + ex.toString());
          await this.sleepPromise(2000); // wait 2 secs and try again - maybe EL client is busy...
          await this.loadWalletState();
        }
      } while(!txPromise && retryCount++ < 3);
      if(!txPromise)
        throw txError;

      this.walletState.nonce++;
      this.walletState.balance -= claimTx.amount;
      if(!this.tokenState)
        this.walletState.nativeBalance -= claimTx.amount;
      this.updateFaucetStatus();

      this.pendingTxQueue[claimTx.txhash] = claimTx;
      ServiceManager.GetService(FaucetStoreDB).removeQueuedClaimTx(claimTx.session);
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Submitted claim transaction " + claimTx.session + " [" + this.readableAmount(claimTx.amount) + "] to: " + claimTx.target + ": " + claimTx.txhash);

      claimTx.status = ClaimTxStatus.PENDING;
      claimTx.emit("pending");

      // await transaction receipt
      txPromise.catch((ex) => {
        if(ex.toString().match(/Transaction was not mined within/)) {
          // poll receipt
          return this.awaitTransactionReceipt(claimTx.txhash);
        }
        else {
          throw ex;
        }
      }).then((receipt) => {
        delete this.pendingTxQueue[claimTx.txhash];
        claimTx.txblock = receipt.blockNumber;
        claimTx.status = ClaimTxStatus.CONFIRMED;
        claimTx.txfee = BigInt(receipt.effectiveGasPrice) * BigInt(receipt.gasUsed);
        this.walletState.nativeBalance -= claimTx.txfee;
        if(!this.tokenState)
          this.walletState.balance -= claimTx.txfee;

        claimTx.emit("confirmed");
        ServiceManager.GetService(FaucetStatsLog).addClaimStats(claimTx);
      }, (error) => {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Transaction for " + claimTx.target + " failed: " + error.toString());
        delete this.pendingTxQueue[claimTx.txhash];
        claimTx.failReason = "Transaction Error: " + error.toString();
        claimTx.status = ClaimTxStatus.FAILED;
        claimTx.emit("failed");
      }).then(() => {
        this.historyTxDict[claimTx.nonce] = claimTx;
        setTimeout(() => {
          delete this.historyTxDict[claimTx.nonce];
        }, 30 * 60 * 1000);
      });
    } catch(ex) {
      claimTx.failReason = "Processing Exception: " + ex.toString();
      claimTx.status = ClaimTxStatus.FAILED;
      claimTx.emit("failed");
    }
  }

  private async awaitTransactionReceipt(txhash: string): Promise<TransactionReceipt> {
    try {
      let receipt: TransactionReceipt;
      do {
        await this.sleepPromise(30000); // 30 secs
        receipt = await this.web3.eth.getTransactionReceipt(txhash);
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Polled transaction receipt for " + txhash + ": " + (receipt ? "found!" : "pending"));
      } while(!receipt);
      return receipt;
    } catch(ex) {
      if(ex.toString().match(/CONNECTION ERROR/)) {
        // just retry when RPC connection issue
        return this.awaitTransactionReceipt(txhash);
      }

      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Error while polling transaction receipt for " + txhash + ": " + ex.toString());
      throw ex;
    }
  }

  private async sendTransaction(txhex: string): Promise<[string, Promise<TransactionReceipt>]> {
    let txhashDfd = new PromiseDfd<string>();
    let receiptDfd = new PromiseDfd<TransactionReceipt>();
    let txStatus = 0;

    let txPromise = this.web3.eth.sendSignedTransaction("0x" + txhex);
    txPromise.once('transactionHash', (hash) => {
      txStatus = 1;
      txhashDfd.resolve(hash);
    });
    txPromise.once('receipt', (receipt) => {
      txStatus = 2;
      receiptDfd.resolve(receipt);
    });
    txPromise.on('error', (error) => {
      if(txStatus === 0)
        txhashDfd.reject(error);
      else
        receiptDfd.reject(error);
    });

    let txHash = await txhashDfd.promise;
    return [txHash, receiptDfd.promise];
  }


  private async tryRefillWallet() {
    if(!faucetConfig.ethRefillContract)
      return;
    if(this.walletRefilling)
      return;
    let now = Math.floor(new Date().getTime() / 1000);
    if(this.lastWalletRefillTry && now - this.lastWalletRefillTry < 60)
      return;
    if(this.lastWalletRefill && faucetConfig.ethRefillContract.cooldownTime && now - this.lastWalletRefill < faucetConfig.ethRefillContract.cooldownTime)
      return;
    this.lastWalletRefillTry = now;

    let walletBalance = this.walletState.balance - ServiceManager.GetService(PoWRewardLimiter).getUnclaimedBalance() - this.getQueuedAmount();
    let refillAction: string = null;
    if(faucetConfig.ethRefillContract.overflowBalance && walletBalance > BigInt(faucetConfig.ethRefillContract.overflowBalance.toString()))
      refillAction = "overflow";
    else if(walletBalance < BigInt(faucetConfig.ethRefillContract.triggerBalance.toString()))
      refillAction = "refill";
    
    if(!refillAction)
      return;
    
    this.walletRefilling = true;
    try {
      let txResult: [string, Promise<TransactionReceipt>];
      if(refillAction == "refill")
        txResult = await this.refillWallet();
      else if(refillAction == "overflow")
        txResult = await this.overflowWallet(walletBalance - BigInt(faucetConfig.ethRefillContract.overflowBalance.toString()));
      
      this.lastWalletRefill = Math.floor(new Date().getTime() / 1000);

      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Sending " + refillAction + " transaction to vault contract: " + txResult[0]);

      let txReceipt: TransactionReceipt;
      try {
        txReceipt = await txResult[1];
      } catch(ex) {
        if(ex.toString().match(/Transaction was not mined within/))
          txReceipt = await this.awaitTransactionReceipt(txResult[0]);
        else
          throw ex;
      }
      if(!txReceipt.status)
        throw txReceipt;

      txResult[1].then((receipt) => {
        this.walletRefilling = false;
        if(!receipt.status)
          throw receipt;
        
        this.loadWalletState(); // refresh balance
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Faucet wallet successfully refilled from vault contract.");
      }).catch((err) => {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Faucet wallet refill transaction reverted: " + err.toString());
      });
    } catch(ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Faucet wallet refill from vault contract failed: " + ex.toString());
      this.walletRefilling = false;
    }
  }

  private async refillWallet(): Promise<[string, Promise<TransactionReceipt>]> {
    let refillContractAbi = JSON.parse(faucetConfig.ethRefillContract.abi);
    let refillContract = new this.web3.eth.Contract(refillContractAbi, faucetConfig.ethRefillContract.contract, {
      from: this.walletAddr,
    });
    let refillAmount = BigInt(faucetConfig.ethRefillContract.requestAmount) || 0n;
    let refillAllowance: bigint = null;

    let getCallArgs = (args) => {
      return args.map((arg) => {
        switch(arg) {
          case "{walletAddr}":
            arg = this.walletAddr;
            break;
          case "{amount}":
            arg = refillAmount;
            break;
          case "{token}":
            arg = this.tokenState?.address;
            break;
        }
        return arg;
      })
    };

    if(faucetConfig.ethRefillContract.allowanceFn) {
      // check allowance
      let callArgs = getCallArgs(faucetConfig.ethRefillContract.allowanceFnArgs || ["{walletAddr}"]);
      refillAllowance = BigInt(await refillContract.methods[faucetConfig.ethRefillContract.allowanceFn].apply(this, callArgs).call());
      if(refillAllowance == 0n)
        throw "no withdrawable funds from refill contract";
      if(refillAmount > refillAllowance)
        refillAmount = refillAllowance;
    }

    if(faucetConfig.ethRefillContract.checkContractBalance) {
      let checkAddr = (typeof faucetConfig.ethRefillContract.checkContractBalance === "string" ? faucetConfig.ethRefillContract.checkContractBalance : faucetConfig.ethRefillContract.contract);
      let contractBalance = BigInt(await this.web3.eth.getBalance(checkAddr));
      let dustBalance = faucetConfig.ethRefillContract.contractDustBalance ? BigInt(faucetConfig.ethRefillContract.contractDustBalance.toString()) : 1000000000n;
      if(contractBalance <= dustBalance)
        throw "refill contract is out of funds";
      if(refillAmount > contractBalance)
        refillAmount = contractBalance;
    }

    let callArgs = getCallArgs(faucetConfig.ethRefillContract.withdrawFnArgs || ["{amount}"]);
    let txHex = await this.buildEthTx(
      faucetConfig.ethRefillContract.contract,
      0n, 
      this.walletState.nonce, 
      refillContract.methods[faucetConfig.ethRefillContract.withdrawFn].apply(this, callArgs).encodeABI(),
      faucetConfig.ethRefillContract.withdrawGasLimit
    );

    let txResult = await this.sendTransaction(txHex);
    this.walletState.nonce++;

    return txResult;
  }

  private async overflowWallet(amount: bigint): Promise<[string, Promise<TransactionReceipt>]> {
    let refillContractAbi = JSON.parse(faucetConfig.ethRefillContract.abi);
    let refillContract = new this.web3.eth.Contract(refillContractAbi, faucetConfig.ethRefillContract.contract, {
      from: this.walletAddr,
    });

    let getCallArgs = (args) => {
      return args.map((arg) => {
        switch(arg) {
          case "{walletAddr}":
            arg = this.walletAddr;
            break;
          case "{amount}":
            arg = amount;
            break;
          case "{token}":
            arg = this.tokenState?.address;
            break;
        }
        return arg;
      })
    };

    let callArgs = getCallArgs(faucetConfig.ethRefillContract.depositFnArgs || []);
    let txHex = await this.buildEthTx(
      faucetConfig.ethRefillContract.contract,
      amount, 
      this.walletState.nonce, 
      faucetConfig.ethRefillContract.depositFn ? refillContract.methods[faucetConfig.ethRefillContract.depositFn].apply(this, callArgs).encodeABI() : undefined,
      faucetConfig.ethRefillContract.withdrawGasLimit
    );

    let txResult = await this.sendTransaction(txHex);
    this.walletState.nonce++;

    return txResult;
  }

  public getFaucetRefillCooldown(): number {
    let now = Math.floor(new Date().getTime() / 1000);
    if(!faucetConfig.ethRefillContract || !faucetConfig.ethRefillContract.cooldownTime)
      return 0;
    if(!this.lastWalletRefill)
      return 0;
    let cooldown = faucetConfig.ethRefillContract.cooldownTime - (now - this.lastWalletRefill);
    if(cooldown < 0)
      return 0;
    return cooldown;
  }

}
