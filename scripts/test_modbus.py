from pymodbus.client import ModbusSerialClient
import struct

# Initialize the exact parameters the Chint meter expects
client = ModbusSerialClient(
    port='COM4', 
    baudrate=9600, 
    bytesize=8, 
    parity='N', 
    stopbits=1,
    timeout=2 
)

if client.connect():
    print("Connected to COM4 successfully.")
    
    # Updated for pymodbus 3.11+ using device_id
    response = client.read_holding_registers(address=8210, count=2, device_id=1)
    
    if response.isError():
        print(f"Modbus Error: {response}")
    else:
        # Decode IEEE-754 Big-Endian Float32
        registers = response.registers
        packed_data = struct.pack('>HH', registers[0], registers[1])
        active_power_raw = struct.unpack('>f', packed_data)[0]
        
        print(f"Success! Raw Register Data: {registers}")
        print(f"Scaled Active Power: {active_power_raw * 0.1:.2f} W")
else:
    print("Failed to open COM4. Is another program using it?")

client.close()