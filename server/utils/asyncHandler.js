function asyncHandler(fn) {
  return function asyncUtilWrap(...args) {
    console.log('args', args);
    
    const fnReturn = fn(...args);
    const next = args[args.length - 1];
    return Promise.resolve(fnReturn).catch(next);
  }
}

module.exports = asyncHandler;