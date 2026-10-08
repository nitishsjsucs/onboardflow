-- Simulated clock offset, read only when SIM_CLOCK=on (eval runs). Production ignores it.
CREATE TABLE sim_clock (id INTEGER PRIMARY KEY CHECK (id = 1), offset_ms INTEGER NOT NULL);
INSERT INTO sim_clock (id, offset_ms) VALUES (1, 0);
