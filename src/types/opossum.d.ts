declare module 'opossum' {
  export type CircuitBreakerOptions = {
    errorThresholdPercentage?: number
    volumeThreshold?: number
    resetTimeout?: number
    timeout?: number
  }

  export default class CircuitBreaker<TArgs, TResult> {
    constructor(action: (args: TArgs) => Promise<TResult>, options?: CircuitBreakerOptions)
    fire(args: TArgs): Promise<TResult>
  }
}
