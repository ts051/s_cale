const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function loadDragHelpers(path) {
    const html = fs.readFileSync(path, 'utf8');
    const timers = new Map();
    let timerId = 0;
    let switches = [];
    let hitDate = '';
    const hints = new Set();
    const cell = rect => ({ getBoundingClientRect: () => rect });
    const context = vm.createContext({
        calendar: {
            view: { type: 'dayGridMonth' },
            prev: () => switches.push('prev'),
            next: () => switches.push('next')
        },
        window: { innerHeight: 800 },
        document: {
            querySelectorAll: selector => selector.includes('[data-date]')
                ? [cell({ left: 10, top: 100 }), cell({ right: 710, bottom: 750 })] : [],
            querySelector: () => null,
            elementFromPoint: () => hitDate ? {
                closest: () => ({ getAttribute: () => hitDate })
            } : null,
            createElement: () => {
                const hint = { style: {}, remove: () => hints.delete(hint) };
                return hint;
            },
            body: { appendChild: hint => hints.add(hint) },
            removeEventListener: () => {}
        },
        setTimeout: (callback, delay) => {
            timers.set(++timerId, { callback, delay });
            return timerId;
        },
        clearTimeout: id => timers.delete(id),
        dayCardDragState: null,
        suppressCalendarSwipeUntil: 0
    });
    const start = html.indexOf('        function formatDateForEventPayload(');
    const end = html.indexOf('        function startDayCardDrag(');
    vm.runInContext(html.slice(start, end), context);
    const state = { active: true, monthDirection: '', ghost: null };
    context.dayCardDragState = state;
    return {
        context, state, timers, switches, hints,
        point: (x, y, date = '') => {
            hitDate = date;
            context.updateDayCardDragGhost(state, x, y);
        },
        tick: () => {
            assert.equal(timers.size, 1);
            const [id, timer] = [...timers][0];
            timers.delete(id);
            timer.callback();
            return timer.delay;
        }
    };
}

for (const path of ['docs/index.html', 'templates/index.html']) {
    test(`${path}: crossing either edge waits, repeats, and preserves the drag`, () => {
        for (const [y, direction] of [[90, 'prev'], [760, 'next']]) {
            const h = loadDragHelpers(path);
            const originalEvent = { id: 'original', start: '2026-12-30', end: '2027-01-02' };
            h.state.eventData = originalEvent;
            h.point(300, y);
            assert.deepEqual(h.switches, []);
            assert.equal(h.hints.size, 1);
            assert.equal(h.tick(), 650);
            assert.equal(h.tick(), 1000);
            assert.deepEqual(h.switches, [direction, direction]);
            assert.equal(h.state.eventData, originalEvent);
            h.point(300, 200, '2027-01-05');
            assert.equal(h.state.targetDate, '2027-01-05');
            assert.equal(h.timers.size, 0);
            assert.equal(h.hints.size, 0);
        }
    });

    test(`${path}: leaving the edge or finishing cancels pending navigation`, () => {
        const h = loadDragHelpers(path);
        h.point(300, 90);
        h.point(0, 90);
        assert.equal(h.timers.size, 0);
        h.point(300, 760);
        h.point(300, 90);
        assert.equal(h.tick(), 650);
        assert.deepEqual(h.switches, ['prev']);
        h.context.finishDayCardDragState();
        assert.equal(h.timers.size, 0);
        assert.equal(h.hints.size, 0);
        assert.equal(h.context.dayCardDragState, null);
        assert.ok(h.context.suppressCalendarSwipeUntil > Date.now());
    });

    test(`${path}: crossing months preserves full event duration and time`, () => {
        const { context } = loadDragHelpers(path);
        const payload = context.buildPayloadForDayCardDrop({
            title: 'multi-day', start: '2026-12-30', end: '2027-01-02', allDay: true
        }, '2027-02-28');
        assert.equal(payload.start, '2027-02-28');
        assert.equal(payload.end, '2027-03-03');
        const timed = context.buildPayloadForDayCardDrop({
            title: 'overnight', start: '2026-10-31T23:30:00', end: '2026-11-01T01:15:00',
            allDay: false, extendedProps: { memo: 'memo', label_id: 7, is_shared: true }
        }, '2027-01-31');
        assert.equal(timed.start, '2027-01-31T23:30:00');
        assert.equal(timed.end, '2027-02-01T01:15:00');
        assert.equal(timed.memo, 'memo');
        assert.equal(timed.label_id, 7);
        assert.equal(timed.is_shared, true);
    });
}
