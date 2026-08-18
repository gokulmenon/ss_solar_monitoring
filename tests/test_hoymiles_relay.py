import importlib.util
import struct
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
    def test_cloud_batch_collects_only_non_zero_port_rows(self):
        relay = load_relay_module()
        snapshot = relay.HoymilesSnapshot(
            timestamp="2026-08-02T12:00:00Z",
            device_serial_number="dtu",
            status="OK",
            error=None,
            total_active_power_w=300,
            daily_yield_wh=100,
            inverter_count=1,
            port_count=3,
            inverters=[
                relay.HoymilesInverterReading(
                    serial_number="inv-1",
                    ports=[
                        relay.HoymilesPortReading(
                            serial_number="inv-1",
                            port_number=1,
                            power_w=100,
                            voltage_v=40.0,
                            energy_daily_raw=25,
                        ),
                        relay.HoymilesPortReading(
                            serial_number="inv-1",
                            port_number=2,
                            power_w=0,
                            voltage_v=40.0,
                            energy_daily_raw=25,
                        ),
                        relay.HoymilesPortReading(
                            serial_number="inv-1",
                            port_number=3,
                            power_w=200,
                            voltage_v=41.0,
                            energy_daily_raw=50,
                        ),
                    ],
                )
            ],
        )
        batch = relay.CloudBatchState(bucket_start="2026-08-02T12:00:00Z", local_day="2026-08-02")

        batch.add_hoymiles_snapshot(snapshot)
        batch.add_hoymiles_snapshot(snapshot)

        self.assertEqual(len(batch.port_rows), 2)
        self.assertEqual(batch.port_rows[0]["inverter_serial"], "inv-1")
        self.assertEqual(batch.port_rows[0]["port_number"], 1)
        self.assertEqual(batch.port_rows[1]["dc_power_w"], 200.0)

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
        sleep.assert_called_with(relay.HOYMILES_CHUNK_DELAY_SECONDS)

    def test_passively_decodes_meter_request_response_pairs(self):
        relay = load_relay_module()
        parser = relay.ModbusMeterSniffer(142)

        def frame(payload):
            return payload + relay.modbus_crc16(payload).to_bytes(2, "little")

        power_request = frame(bytes([142, 3]) + (8210).to_bytes(2, "big") + (2).to_bytes(2, "big"))
        power_response = frame(bytes([142, 3, 4]) + struct.pack(">f", -1234.0))
        voltage_request = frame(bytes([142, 3]) + (8198).to_bytes(2, "big") + (2).to_bytes(2, "big"))
        voltage_response = frame(bytes([142, 3, 4]) + struct.pack(">f", 2397.0))

        first_snapshots, first_valid = parser.feed(b"\x00\xFF" + power_request[:5])
        second_snapshots, second_valid = parser.feed(
            power_request[5:] + power_response + voltage_request + voltage_response
        )

        self.assertFalse(first_snapshots)
        self.assertFalse(first_valid)
        self.assertTrue(second_valid)
        self.assertEqual(len(second_snapshots), 2)
        self.assertEqual(second_snapshots[0].total_active_power_w, -123)
        self.assertEqual(second_snapshots[0].phase_a_voltage_v, None)
        self.assertEqual(second_snapshots[1].total_active_power_w, -123)
        self.assertEqual(second_snapshots[1].phase_a_voltage_v, 239.7)

    def test_retains_a_fragmented_93_byte_response_until_complete(self):
        relay = load_relay_module()
        parser = relay.ModbusMeterSniffer(142)

        def frame(payload):
            return payload + relay.modbus_crc16(payload).to_bytes(2, "little")

        start_register = 8192
        request = frame(
            bytes([142, 3]) + start_register.to_bytes(2, "big") + (44).to_bytes(2, "big")
        )
        payload = bytearray(88)
        voltage_offset = (relay.METER_PHASE_A_VOLTAGE_REGISTER - start_register) * 2
        power_offset = (relay.METER_TOTAL_ACTIVE_POWER_REGISTER - start_register) * 2
        payload[voltage_offset : voltage_offset + 4] = struct.pack(">f", 2397.0)
        payload[power_offset : power_offset + 4] = struct.pack(">f", 43860.0)
        response = frame(bytes([142, 3, 88]) + bytes(payload))

        parser.feed(request)
        snapshots, saw_valid_packet = parser.feed(response[:63])

        self.assertFalse(snapshots)
        self.assertFalse(saw_valid_packet)
        self.assertEqual(len(parser.buffer), 63)

        snapshots, saw_valid_packet = parser.feed(response[63:])

        self.assertTrue(saw_valid_packet)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].total_active_power_w, 4386)
        self.assertEqual(snapshots[0].phase_a_voltage_v, 239.7)

    def test_sniffer_rejects_frames_with_bad_crc(self):
        relay = load_relay_module()
        parser = relay.ModbusMeterSniffer(142)
        invalid_request = bytes([142, 3]) + (8210).to_bytes(2, "big") + (2).to_bytes(2, "big") + b"\0\0"

        snapshots, saw_valid_packet = parser.feed(invalid_request)

        self.assertFalse(snapshots)
        self.assertFalse(saw_valid_packet)


if __name__ == "__main__":
    unittest.main()
