import paho.mqtt.client as mqtt

mqtt_client = mqtt.Client()
mqtt_client.username_pw_set("ttsam", "ttsam")
mqtt_client.connect("0.0.0.0", 1883)

topic = "ttsam"

for i in range(10):
    message = "test"
    mqtt_client.publish(topic, message)
