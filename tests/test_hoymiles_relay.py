import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


RELAY_PATH = Path(__file__).parents[1] / "bridge" / "modbus_ws_relay.py"


def load_relay_module():
    # The test environment may not install the relay-only requests dependency.
    sys.modules.setdefault("requests", types.SimpleNamespace(get=lambda *args, **kwargs: None))
    spec = importlib.util.spec_from_file_location("test_relay_module", RELAY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load relay module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeHoymilesClient:
    connected = True

    def connect(self):
        return True

    def close(self):
        return None


class HoymilesRelayTest(unittest.TestCase):
    def test_reads_48_ports_in_safe_chunks_and_groups_four_ports_per_inverter(self):
        relay = load_relay_module()
        calls = []

        def fake_read(_client, *, start_address, count, unit_id):
            calls.append((start_address, count, unit_id))
            if start_address == relay.HOYMILES_DTU_SERIAL_ADDRESS:
                return [1, 2, 3]

            registers = []
            first_port = (
                start_address - relay.HOYMILES_INVERTER_BASE_ADDRESS
            ) // relay.HOYMILES_INVERTER_REGISTER_STRIDE

            for offset in range(count // relay.HOYMILES_INVERTER_REGISTER_STRIDE):
                port_index = first_port + offset
                inverter_index = port_index // relay.HOYMILES_PORTS_PER_INVERTER
                port_number = (port_index % relay.HOYMILES_PORTS_PER_INVERTER) + 1
                raw = bytearray(80)  # one complete 40-register port block
                raw[1:7] = bytes([0x10, 0, 0, 0, 0, inverter_index + 1])
                raw[7] = port_number
                raw[8:10] = (400).to_bytes(2, "big")
                raw[10:12] = (100).to_bytes(2, "big")
                raw[12:14] = (2400).to_bytes(2, "big")
                raw[14:16] = (6000).to_bytes(2, "big")
                raw[16:18] = (500).to_bytes(2, "big")
                raw[18:20] = (100 + port_index).to_bytes(2, "big")
                raw[20:24] = (1000 + port_index).to_bytes(4, "big")
                raw[24:26] = (250).to_bytes(2, "big", signed=True)
                raw[32] = 1
                registers.extend(
                    int.from_bytes(raw[index : index + 2], "big")
                    for index in range(0, 80, 2)
                )

            return registers

        with (
            patch.object(relay, "create_hoymiles_modbus_client", return_value=FakeHoymilesClient()),
            patch.object(relay, "read_hoymiles_registers", side_effect=fake_read),
            patch.object(relay.time, "sleep") as sleep,
        ):
            snapshot = relay.read_hoymiles_snapshot_sync()

        self.assertEqual(snapshot.inverter_count, 12)
        self.assertEqual(snapshot.port_count, 48)
        self.assertEqual(sorted(len(inverter.ports) for inverter in snapshot.inverters), [4] * 12)
        self.assertEqual([count for _, count, _ in calls[1:]], [120] * 16)
        self.assertEqual([start for start, _, _ in calls[1:]], [4096 + 120 * index for index in range(16)])
        self.assertEqual(sleep.call_count, 15)
        sleep.assert_called_with(1.0)


if __name__ == "__main__":
    unittest.main()
