# Local allocation-stage profile

These local PHP 8.5.8/Wrangler profiles explain the measured allocator change. Temporary diagnostic code inspected the Emscripten heap and filesystem nodes, paused at six explicit stages with the V8 debugger, and captured `Runtime.getHeapUsage`. A temporary MU plugin recorded PHP allocator counters across WordPress hooks. Both instrumentation mechanisms were removed before committing or deploying the runtime change. No remote instrumentation or license bypass was used.

The original allocator held WASM at 67,108,864 bytes throughout archive extraction, canonical filesystem hydration, and boot. Rendering then requested heap growth to 69,210,112, 81,793,024, 98,570,240, and 119,541,760 bytes. The Emscripten loader's geometric growth yielded 139,198,464 bytes of linear memory. PHP's reported allocator peak was 50,855,936 bytes, illustrating why PHP counters alone did not describe the isolate requirement.

The streamed JavaScript WordPress ZIP extraction experiment still ended at 139,198,464 WASM bytes and was reverted. It did not justify a production archive-path change. The filesystem figures enumerate accessible Emscripten filesystem nodes and backing buffers; they are not a heap snapshot or an attribution of all remote memory.

Using PHP's supported `USE_ZEND_ALLOC=0` startup environment instead ended at 80,543,744 WASM bytes with the same native heading and HTTP 200. PHP's [allocator implementation](https://github.com/php/php-src/blob/master/Zend/zend_alloc.c) supports this system-malloc mode. It disables PHP's allocator accounting, so zero-valued PHP counters are reported as unavailable, not as zero consumption. The Worker continues to enforce its actual resource limits.

The local V8 measurements and remote sampled metrics are different measurement surfaces. No arithmetic combination of these local fields is presented as a remote peak. The [subsequent real Worker evidence](../system-allocator/README.md) remains the resource decision basis.
