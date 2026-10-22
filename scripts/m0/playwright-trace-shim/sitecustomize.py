"""M0 diagnostic shim: capture a real Playwright trace for the replay browser.

The replay browser lives inside the OpenAdapt bridge subprocess
(``packages/workflow/python/copilot_bridge.py``). This module is imported
automatically by CPython's ``site`` module when its directory is on
``PYTHONPATH``, so the trace is produced *without* editing ``openadapt_flow``
or any of this project's source.

Inert unless ``M0_TRACE_DIR`` is set. Every failure is reported on stderr and
never raised: a diagnostic layer must not be able to change the run it is
observing.
"""

from __future__ import annotations

import atexit
import os
import sys
import time

_TRACE_DIR = os.environ.get("M0_TRACE_DIR")

if _TRACE_DIR:
    try:
        from playwright.sync_api import Browser, BrowserContext, Playwright
    except Exception as exc:  # pragma: no cover - environment dependent
        sys.stderr.write(f"[m0-trace] playwright unavailable: {exc}\n")
    else:
        _started_ms = int(time.time() * 1000)
        _contexts: list[object] = []
        _seen: set[int] = set()
        _counter = 0

        def _note(message: str) -> None:
            sys.stderr.write(f"[m0-trace] {message}\n")

        def _begin(context: object) -> None:
            if context is None or id(context) in _seen:
                return
            _seen.add(id(context))
            try:
                context.tracing.start(  # type: ignore[attr-defined]
                    name="m0-run", screenshots=True, snapshots=True, sources=False
                )
                _contexts.append(context)
            except Exception as exc:  # pragma: no cover - defensive
                _note(f"tracing.start failed: {type(exc).__name__}: {exc}")

        def _finish(only: object | None = None) -> None:
            global _counter
            for context in list(_contexts):
                if only is not None and context is not only:
                    continue
                _contexts.remove(context)
                target = os.path.join(
                    _TRACE_DIR,
                    f"trace-{_started_ms}-{os.getpid()}-{_counter}.zip",
                )
                _counter += 1
                try:
                    context.tracing.stop(path=target)  # type: ignore[attr-defined]
                    _note(f"wrote {target}")
                except Exception as exc:  # pragma: no cover - defensive
                    _note(f"tracing.stop failed: {type(exc).__name__}: {exc}")

        _orig_new_page = Browser.new_page

        def _new_page(self, *args, **kwargs):
            page = _orig_new_page(self, *args, **kwargs)
            _begin(getattr(page, "context", None))
            return page

        Browser.new_page = _new_page  # type: ignore[assignment]

        _orig_new_context = Browser.new_context

        def _new_context(self, *args, **kwargs):
            context = _orig_new_context(self, *args, **kwargs)
            _begin(context)
            return context

        Browser.new_context = _new_context  # type: ignore[assignment]

        _orig_context_close = BrowserContext.close

        def _context_close(self, *args, **kwargs):
            _finish(only=self)
            return _orig_context_close(self, *args, **kwargs)

        BrowserContext.close = _context_close  # type: ignore[assignment]

        _orig_browser_close = Browser.close

        def _browser_close(self, *args, **kwargs):
            _finish()
            return _orig_browser_close(self, *args, **kwargs)

        Browser.close = _browser_close  # type: ignore[assignment]

        _orig_stop = Playwright.stop

        def _stop(self, *args, **kwargs):
            _finish()
            return _orig_stop(self, *args, **kwargs)

        Playwright.stop = _stop  # type: ignore[assignment]

        atexit.register(_finish)
