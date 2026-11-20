import express from 'express'
import cors from 'cors'
import 'dotenv/config'


const app= express()

app.use(cors())
app.use(express.json())

import { MongoClient, ObjectId } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient= await connectToMongoDB()
const db= connectedClient.db('rental-platform')

const usersCollection= db.collection('users')
const equipmentCollection= db.collection('equipment')
const bookingsCollection= db.collection('bookings')
const paymentsCollection= db.collection('payments')


// http://localhost:5000/api/addEquipment

app.listen(5000, ()=>{
    console.log('server is running on port 5000');
})

// equipment related api

app.post('/api/addEquipment', async(req, res)=>{
  const equipment= req.body
  const result= await equipmentCollection.insertOne(equipment)
  res.send(result)
})

app.get('/api/ownerEquipment', async(req, res)=>{
  const query={}
  if(req.query){
    query.ownerEmail= req.query.ownerEmail
  }
    const result= await equipmentCollection.find(query).toArray()
    res.send(result)
})


// all equipment page public route api

app.get('/api/allEquipment', async(req, res)=>{
  const query={}
  if(req.query){
    if(req.query.category){
      query.category= req.query.category
    }
    if(req.query.rentalType){
      query.rentalType= req.query.rentalType
    }
    if(req.query.rentalPrice){
      query.rentalPrice= req.query.rentalPrice
    }
    if(req.query.availableQuantity){
      query.availableQuantity= req.query.availableQuantity
    }
    if(req.query.search){
      query.$or=[
        {name: {$regex: req.query.search, $options: 'i'}},
        {location: {$regex: req.query.search, $options: 'i'}},
        {brand: {$regex: req.query.search, $options: 'i'}}
      ]
    }
  }
    const result= await equipmentCollection.find(query).toArray()
    res.send(result)
})



app.delete('/api/deleteEquipment/:id', async(req, res)=>{
  const {id}= req.params
  const result= await equipmentCollection.deleteOne({_id: new ObjectId(id)})
  res.send(result)
})




